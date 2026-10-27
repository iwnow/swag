import { describe, expect, it } from 'vitest';
import type { BusMessage, PlatformEventInput } from '@swag/contracts';
import {
  createOrchestratorCore,
  type LogContext,
  type OrchestratorBus,
  type OrchestratorCore,
  type SandboxProvider,
  type SandboxSpec,
} from '../src/index.ts';

const SWARM = '0b6f6d2e-6a4c-4c3e-9f5e-111111111111';
const TEMPLATE = 'swag-agent:test';

const TRACE = '4bf92f3577b34da6a3ce929d0e0e4736';

interface Entry {
  level: 'debug' | 'info' | 'warn' | 'error';
  msg: string;
  ctx?: LogContext;
}

interface Fake {
  core: OrchestratorCore;
  entries: Entry[]; // логи ядра
  log: string[]; // порядок публикаций: 'event:<type>' или 'message:<to>'
  events: PlatformEventInput[];
  messages: BusMessage[];
  sandboxes: Map<string, SandboxSpec>;
  runTimers: (ms: number) => void; // срабатывают активные таймеры с этим ms
}

function setup(
  options: {
    agents?: number;
    agentStartMs?: number;
    swarmMs?: number;
    initial?: Map<string, SandboxSpec>;
    createError?: Error;
    removeError?: Error;
  } = {},
): Fake {
  let counter = 0;
  const log: string[] = [];
  const entries: Entry[] = [];
  const at =
    (level: Entry['level']) =>
    (msg: string, ctx?: LogContext): void => {
      entries.push(ctx === undefined ? { level, msg } : { level, msg, ctx });
    };
  const events: PlatformEventInput[] = [];
  const messages: BusMessage[] = [];
  const sandboxes = options.initial ?? new Map<string, SandboxSpec>();
  const timers: { fn: () => void; ms: number; active: boolean }[] = [];

  const provider: SandboxProvider = {
    create: async (spec) => {
      if (options.createError && sandboxes.size > 0) throw options.createError; // падает второй
      const sandboxId = `sb-${++counter}`;
      sandboxes.set(sandboxId, spec);
      return { sandboxId };
    },
    remove: async (sandboxId) => {
      if (options.removeError) throw options.removeError;
      sandboxes.delete(sandboxId);
    },
    list: async (match) =>
      [...sandboxes.entries()]
        .filter(([, spec]) =>
          Object.entries(match).every(([k, v]) =>
            v === true ? k in spec.metadata : spec.metadata[k] === v,
          ),
        )
        .map(([id]) => id),
  };
  const bus: OrchestratorBus = {
    publishEvent: async (event) => {
      events.push(event);
      log.push(`event:${event.type}`);
    },
    publishMessage: async (message) => {
      messages.push(message);
      log.push(`message:${message.to}`);
    },
  };
  const core = createOrchestratorCore({
    version: 'test',
    sandboxes: provider,
    bus,
    clock: { now: () => '2026-10-22T10:00:00.000Z' },
    timers: {
      setTimeout: (fn, ms) => {
        const timer = { fn, ms, active: true };
        timers.push(timer);
        return timer;
      },
      clearTimeout: (id) => {
        (id as { active: boolean }).active = false;
      },
    },
    ids: { uuid: () => `00000000-0000-4000-8000-${String(++counter).padStart(12, '0')}` },
    log: { debug: at('debug'), info: at('info'), warn: at('warn'), error: at('error') },
    trace: { currentTraceId: () => TRACE },
    agent: { template: TEMPLATE, stepDelayMs: 1000 },
    timeouts: { agentStartMs: options.agentStartMs ?? 30000, swarmMs: options.swarmMs ?? 300000 },
  });
  return {
    core,
    entries,
    log,
    events,
    messages,
    sandboxes,
    runTimers: (ms) => {
      for (const timer of timers) {
        if (timer.active && timer.ms === ms) {
          timer.active = false;
          timer.fn();
        }
      }
    },
  };
}

const agents = (count: number) =>
  Array.from({ length: count }, (_, i) => ({
    id: `agent-${i + 1}`,
    name: `A${i + 1}`,
    role: `r${i + 1}`,
  }));
const launchBody = (count: number) => ({ swarmId: SWARM, task: 'T', agents: agents(count) });

let seq = 0;
const agentEvent = (type: 'agent.started' | 'agent.result', agentId: string, data: object) =>
  ({
    id: `00000000-0000-4000-9000-${String(++seq).padStart(12, '0')}`,
    swarmId: SWARM,
    ts: '2026-10-22T10:00:02.000Z',
    source: 'agent',
    agentId,
    traceId: null,
    type,
    data,
  }) as unknown;

describe('orchestrator-core', () => {
  it('AC-000-16: info() возвращает ServiceInfo сервиса orchestrator с версией из оболочки', () => {
    expect(setup().core.info()).toEqual({ service: 'orchestrator', version: 'test' });
  });

  it('AC-001-11: три песочницы с шаблоном, метаданными и ровно нужным env; цепочка AGENT_NEXT; три agent.launched', async () => {
    const fake = setup();
    const result = await fake.core.launch(launchBody(3));
    expect(result.ok).toBe(true);
    const specs = [...fake.sandboxes.values()];
    expect(specs).toHaveLength(3);
    for (const spec of specs) expect(spec.template).toBe(TEMPLATE);
    expect(specs[0]?.metadata).toEqual({
      'swag.kind': 'agent',
      'swag.swarm': SWARM,
      'swag.agent': 'agent-1',
    });
    const envKeys = [
      'AGENT_ID',
      'AGENT_NAME',
      'AGENT_NEXT',
      'AGENT_ROLE',
      'AGENT_STEP_DELAY_MS',
      'SWARM_ID',
    ];
    for (const spec of specs) expect(Object.keys(spec.env).sort()).toEqual(envKeys);
    expect(specs.map((s) => s.env['AGENT_NEXT'])).toEqual(['agent-2', 'agent-3', '']);
    expect(specs[0]?.env['AGENT_STEP_DELAY_MS']).toBe('1000');
    expect(fake.events.filter((e) => e.type === 'agent.launched')).toHaveLength(3);
  });

  it('AC-001-12: лишнее поле image — validation_error, песочницы не создаются', async () => {
    const fake = setup();
    const result = await fake.core.launch({ ...launchBody(2), image: 'evil:latest' });
    expect(result.ok).toBe(false);
    expect(fake.sandboxes.size).toBe(0);
  });

  it('AC-001-13: задача уходит только когда стартовали все; затем swarm.started', async () => {
    const fake = setup();
    await fake.core.launch(launchBody(3));
    await fake.core.handleEvent(agentEvent('agent.started', 'agent-1', {}));
    await fake.core.handleEvent(agentEvent('agent.started', 'agent-2', {}));
    expect(fake.messages).toHaveLength(0);
    await fake.core.handleEvent(agentEvent('agent.started', 'agent-3', {}));
    expect(fake.messages).toHaveLength(1);
    expect(fake.messages[0]).toMatchObject({
      from: 'user',
      to: 'agent-1',
      text: 'T',
      swarmId: SWARM,
    });
    const tail = fake.log.slice(-2);
    expect(tail).toEqual(['message:agent-1', 'event:swarm.started']);
  });

  it('AC-001-14: не все стартовали за agentStartMs — все песочницы удалены, agent.stopped по каждому, swarm.failed agent_start_timeout', async () => {
    const fake = setup({ agentStartMs: 30000 });
    await fake.core.launch(launchBody(3));
    await fake.core.handleEvent(agentEvent('agent.started', 'agent-1', {}));
    fake.runTimers(30000);
    await waitMicrotasks();
    expect(fake.sandboxes.size).toBe(0);
    expect(fake.events.filter((e) => e.type === 'agent.stopped')).toHaveLength(3);
    const last = fake.events.at(-1);
    expect(last).toMatchObject({ type: 'swarm.failed', data: { reason: 'agent_start_timeout' } });
  });

  it('AC-001-15: agent.result от последнего — песочницы удалены, agent.stopped по каждому, затем swarm.completed', async () => {
    const fake = setup();
    await fake.core.launch(launchBody(3));
    for (const id of ['agent-1', 'agent-2', 'agent-3'])
      await fake.core.handleEvent(agentEvent('agent.started', id, {}));
    await fake.core.handleEvent(agentEvent('agent.result', 'agent-3', { text: 'R' }));
    expect(fake.sandboxes.size).toBe(0);
    const types = fake.events.map((e) => e.type);
    expect(types.slice(-4)).toEqual([
      'agent.stopped',
      'agent.stopped',
      'agent.stopped',
      'swarm.completed',
    ]);
    expect(fake.events.at(-1)).toMatchObject({ data: { result: 'R' } });
  });

  it('AC-001-16: stop — уборка, agent.stopped, swarm.stopped (reason user); повторный stop — успех без событий; неизвестный — not_found', async () => {
    const fake = setup();
    await fake.core.launch(launchBody(2));
    for (const id of ['agent-1', 'agent-2'])
      await fake.core.handleEvent(agentEvent('agent.started', id, {}));
    const before = fake.events.length;
    expect((await fake.core.stop(SWARM)).ok).toBe(true);
    expect(fake.sandboxes.size).toBe(0);
    const tail = fake.events.slice(before).map((e) => e.type);
    expect(tail).toEqual(['agent.stopped', 'agent.stopped', 'swarm.stopped']);
    expect(fake.events.at(-1)).toMatchObject({ data: { reason: 'user' } });

    const again = fake.events.length;
    expect((await fake.core.stop(SWARM)).ok).toBe(true);
    expect(fake.events.length).toBe(again);

    const unknown = await fake.core.stop('00000000-0000-4000-8000-000000000999');
    expect(unknown.ok === false && unknown.error.code).toBe('not_found');
  });

  it('AC-001-17: swarmMs истёк — уборка и swarm.failed swarm_timeout', async () => {
    const fake = setup({ swarmMs: 300000 });
    await fake.core.launch(launchBody(2));
    for (const id of ['agent-1', 'agent-2'])
      await fake.core.handleEvent(agentEvent('agent.started', id, {}));
    fake.runTimers(300000);
    await waitMicrotasks();
    expect(fake.sandboxes.size).toBe(0);
    expect(fake.events.at(-1)).toMatchObject({
      type: 'swarm.failed',
      data: { reason: 'swarm_timeout' },
    });
  });

  it('AC-016-5: launch и таймаут старта — все события с traceId порта; логи swarm launch и agent start timeout с missing', async () => {
    const fake = setup({ agentStartMs: 30000 });
    await fake.core.launch(launchBody(3));
    await fake.core.handleEvent(agentEvent('agent.started', 'agent-2', {}));
    fake.runTimers(30000);
    await waitMicrotasks();
    const types = fake.events.map((e) => e.type);
    expect(types).toContain('agent.launched');
    expect(types).toContain('agent.stopped');
    expect(types.at(-1)).toBe('swarm.failed');
    for (const event of fake.events) expect(event.traceId).toBe(TRACE);
    expect(fake.entries).toContainEqual({
      level: 'info',
      msg: 'swarm launch',
      ctx: { swarmId: SWARM, agents: 3 },
    });
    expect(fake.entries).toContainEqual({
      level: 'error',
      msg: 'agent start timeout',
      ctx: { swarmId: SWARM, missing: ['agent-1', 'agent-3'] },
    });
  });

  it('AC-016-7: orchestrator-core пишет логи 4.8 — ошибка create, таймаут роя, завершение, ошибка remove', async () => {
    const createError = new Error('no such image');
    const broken = setup({ createError });
    await broken.core.launch(launchBody(2));
    expect(broken.entries).toContainEqual({
      level: 'error',
      msg: 'sandbox create failed',
      ctx: { swarmId: SWARM, agentId: 'agent-2', err: createError },
    });
    expect(broken.entries).toContainEqual({
      level: 'info',
      msg: 'swarm finished',
      ctx: { swarmId: SWARM, status: 'failed' },
    });

    const slow = setup({ swarmMs: 300000 });
    await slow.core.launch(launchBody(1));
    await slow.core.handleEvent(agentEvent('agent.started', 'agent-1', {}));
    slow.runTimers(300000);
    await waitMicrotasks();
    expect(slow.entries).toContainEqual({
      level: 'error',
      msg: 'swarm timeout',
      ctx: { swarmId: SWARM },
    });

    const done = setup();
    await done.core.launch(launchBody(1));
    await done.core.handleEvent(agentEvent('agent.started', 'agent-1', {}));
    await done.core.handleEvent(agentEvent('agent.result', 'agent-1', { text: 'R' }));
    expect(done.entries).toContainEqual({
      level: 'info',
      msg: 'swarm finished',
      ctx: { swarmId: SWARM, status: 'completed' },
    });

    const removeError = new Error('container busy');
    const sticky = setup({ removeError });
    await sticky.core.launch(launchBody(1));
    await sticky.core.stop(SWARM);
    expect(sticky.entries).toContainEqual({
      level: 'warn',
      msg: 'sandbox remove failed',
      ctx: { swarmId: SWARM, agentId: 'agent-1', err: removeError },
    });
    expect(sticky.entries).toContainEqual({
      level: 'info',
      msg: 'swarm finished',
      ctx: { swarmId: SWARM, status: 'stopped' },
    });
  });

  it('AC-001-18: cleanupOrphans удаляет песочницы с swag.kind, чужую оставляет, возвращает 2', async () => {
    const initial = new Map<string, SandboxSpec>([
      [
        'old-1',
        {
          template: 'x',
          env: {},
          metadata: { 'swag.kind': 'agent', 'swag.swarm': 'a', 'swag.agent': 'agent-1' },
        },
      ],
      [
        'old-2',
        {
          template: 'x',
          env: {},
          metadata: { 'swag.kind': 'agent', 'swag.swarm': 'b', 'swag.agent': 'agent-1' },
        },
      ],
      ['foreign', { template: 'x', env: {}, metadata: {} }],
    ]);
    const fake = setup({ initial });
    expect(await fake.core.cleanupOrphans()).toBe(2);
    expect([...fake.sandboxes.keys()]).toEqual(['foreign']);
  });

  it('AC-002-22: env песочниц роя из 001 не содержит ключей /API_KEY|LITELLM/, даже если они есть в process.env', async () => {
    const secrets = {
      OPENROUTER_API_KEY: 'sk-or-fake-test-value',
      LITELLM_MASTER_KEY: 'sk-litellm-fake-test-value',
    };
    const saved = Object.keys(secrets).map((key) => [key, process.env[key]] as const);
    Object.assign(process.env, secrets);
    try {
      const fake = setup();
      await fake.core.launch(launchBody(3));
      const specs = [...fake.sandboxes.values()];
      expect(specs).toHaveLength(3);
      const envKeys = specs.flatMap((spec) => Object.keys(spec.env));
      expect(envKeys.length).toBeGreaterThan(0);
      expect(envKeys.filter((key) => /API_KEY|LITELLM/.test(key))).toEqual([]);
      const envValues = specs.flatMap((spec) => Object.values(spec.env));
      expect(
        Object.keys(secrets).filter((key) =>
          envValues.includes(secrets[key as keyof typeof secrets]),
        ),
      ).toEqual([]);
    } finally {
      for (const [key, value] of saved) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
});

// Даём отработать асинхронным обработчикам после срабатывания таймера.
async function waitMicrotasks(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
}
