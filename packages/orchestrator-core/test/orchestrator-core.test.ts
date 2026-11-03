import { describe, expect, it } from 'vitest';
import {
  SwarmLaunch,
  type BusMessage,
  type LlmSwarmRegistration,
  type PlatformEventInput,
} from '@swag/contracts';
import {
  createOrchestratorCore,
  type LlmSwarms,
  type LogContext,
  type OrchestratorBus,
  type OrchestratorCore,
  type SandboxProvider,
  type SandboxSpec,
  type SecretReader,
} from '../src/index.ts';
import { ORG, nodeHarness, type Respond } from './node-fakes.ts';

const SWARM = '0b6f6d2e-6a4c-4c3e-9f5e-111111111111';
const TEMPLATE = 'swag-agent:test';

const TRACE = '4bf92f3577b34da6a3ce929d0e0e4736';
const LLM_TOKEN = 'fake-gateway-token-0123456789abcdef';

interface Entry {
  level: 'debug' | 'info' | 'warn' | 'error';
  msg: string;
  ctx?: LogContext;
}

interface Fake {
  core: OrchestratorCore;
  entries: Entry[]; // логи ядра
  log: string[]; // порядок: 'event:<type>', 'message:<to>', 'sandbox:create|remove', 'gateway:register|close'
  events: PlatformEventInput[];
  messages: BusMessage[];
  sandboxes: Map<string, SandboxSpec>;
  registrations: LlmSwarmRegistration[];
  closed: string[]; // swarmId вызовов close
  runTimers: (ms: number) => void; // срабатывают активные таймеры с этим ms
  node: ReturnType<typeof nodeHarness>; // фейки портов узлов: песочницы, стейт, кадры
}

function setup(
  options: {
    agents?: number;
    agentStartMs?: number;
    swarmMs?: number;
    initial?: Map<string, SandboxSpec>;
    createError?: Error;
    removeError?: Error;
    registerError?: Error;
    registerHold?: Promise<void>;
    closeError?: Error;
    closeSpent?: number | null;
    agentMaxTokens?: number;
    respond?: Respond; // ответы песочницы узла (граф процесса)
    secrets?: SecretReader; // подмена хранилища секретов узлов
    removeGate?: Promise<void>; // удаление песочниц агентов ждёт этот промис
    onEvent?: (event: PlatformEventInput) => Promise<void>; // вызывается после публикации события
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
      log.push('sandbox:create');
      sandboxes.set(sandboxId, spec);
      return { sandboxId };
    },
    remove: async (sandboxId) => {
      log.push('sandbox:remove');
      if (options.removeGate) await options.removeGate;
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
      await options.onEvent?.(event);
    },
    publishMessage: async (message) => {
      messages.push(message);
      log.push(`message:${message.to}`);
    },
  };
  const registrations: LlmSwarmRegistration[] = [];
  const closed: string[] = [];
  const llmSwarms: LlmSwarms = {
    register: async (reg) => {
      log.push('gateway:register');
      if (options.registerHold) await options.registerHold;
      if (options.registerError) throw options.registerError;
      registrations.push(reg);
    },
    close: async (swarmId) => {
      log.push('gateway:close');
      if (options.closeError) throw options.closeError;
      closed.push(swarmId);
      return options.closeSpent ?? null;
    },
  };
  const node = nodeHarness(options.respond ? { respond: options.respond } : {});
  const core = createOrchestratorCore({
    version: 'test',
    sandboxes: provider,
    bus,
    llmSwarms,
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
    agent: {
      template: TEMPLATE,
      maxSteps: 20,
      maxTokens: options.agentMaxTokens ?? 2048,
      llmGatewayToken: LLM_TOKEN,
      flushTimeoutMs: 2000,
    },
    timeouts: { agentStartMs: options.agentStartMs ?? 30000, swarmMs: options.swarmMs ?? 300000 },
    ...node.nodeDeps,
    ...(options.secrets ? { secrets: options.secrets } : {}),
  });
  return {
    core,
    entries,
    log,
    events,
    messages,
    sandboxes,
    registrations,
    closed,
    node,
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
// Форма роя из count агентов в виде SwarmLaunch (спека 009, 4.3): все пары связаны link, вход и выход — agent-1.
const formEdges = (count: number) => {
  const edges: { from: string; to: string; kind: 'link' }[] = [];
  for (let i = 1; i <= count; i += 1)
    for (let j = i + 1; j <= count; j += 1)
      edges.push({ from: `agent-${i}`, to: `agent-${j}`, kind: 'link' });
  return edges;
};
const launchBody = (count: number) => ({
  swarmId: SWARM,
  orgId: ORG,
  task: 'T',
  budgetMicroUsd: 500000,
  maxTokens: null,
  agents: agents(count),
  programs: [],
  edges: formEdges(count),
  entry: 'agent-1',
  exit: 'agent-1',
});

let seq = 0;
const agentEvent = (
  type: 'agent.started' | 'agent.result' | 'agent.failed',
  agentId: string,
  data: object,
) =>
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

  it('AC-001-11: три песочницы с шаблоном и метаданными; три agent.launched', async () => {
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
    expect(fake.events.filter((e) => e.type === 'agent.launched')).toHaveLength(3);
  });

  it('AC-022-17: env каждой песочницы — ровно ключи 4.8 от ядра; AGENT_PEERS без самого агента; AGENT_ENTRY и AGENT_MODEL из плана; ни ключей провайдеров, ни AGENT_NEXT', async () => {
    const fake = setup();
    const models = ['chat-small', 'chat-large', 'chat-small'] as const;
    const body = {
      ...launchBody(3),
      agents: agents(3).map((agent, i) => ({ ...agent, model: models[i] })),
    };
    expect((await fake.core.launch(body)).ok).toBe(true);
    const specs = [...fake.sandboxes.values()];
    const coreKeys = [
      'AGENT_ENTRY',
      'AGENT_ID',
      'AGENT_MAX_STEPS',
      'AGENT_MAX_TOKENS',
      'AGENT_MODEL',
      'AGENT_NAME',
      'AGENT_PEERS',
      'AGENT_ROLE',
      'LLM_GATEWAY_TOKEN',
      'SWARM_ID',
      'TELEMETRY_FLUSH_TIMEOUT_MS',
    ];
    // Спека 009, 4.6 (шаг 1) и 4.8: агенту-входу команды добавляются AGENT_TASK_FROM и AGENT_RESULT_TO.
    expect(Object.keys(specs[0]?.env ?? {}).sort()).toEqual(
      [...coreKeys, 'AGENT_RESULT_TO', 'AGENT_TASK_FROM'].sort(),
    );
    for (const spec of specs.slice(1)) expect(Object.keys(spec.env).sort()).toEqual(coreKeys);
    for (const spec of specs) {
      expect(spec.env['AGENT_ENTRY']).toBe('agent-1');
      expect(spec.env['AGENT_MAX_STEPS']).toBe('20');
      expect(spec.env['AGENT_MAX_TOKENS']).toBe('2048');
      expect(spec.env['LLM_GATEWAY_TOKEN']).toBe(LLM_TOKEN);
      expect(spec.env['TELEMETRY_FLUSH_TIMEOUT_MS']).toBe('2000');
    }
    expect(specs.map((s) => s.env['AGENT_MODEL'])).toEqual(models);
    const peersOf = (spec: SandboxSpec | undefined): { id: string }[] =>
      JSON.parse(spec?.env['AGENT_PEERS'] ?? '[]');
    expect(peersOf(specs[0])).toEqual([
      { id: 'agent-2', name: 'A2', role: 'r2' },
      { id: 'agent-3', name: 'A3', role: 'r3' },
    ]);
    expect(peersOf(specs[1]).map((p) => p.id)).toEqual(['agent-1', 'agent-3']);
    const allKeys = specs.flatMap((spec) => Object.keys(spec.env));
    expect(allKeys.filter((key) => /_API_KEY$|LITELLM_MASTER_KEY|AGENT_NEXT/.test(key))).toEqual(
      [],
    );
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

  it('AC-001-15: agent.result от агента-входа (agent-1) — песочницы удалены, agent.stopped по каждому, затем swarm.completed с его текстом', async () => {
    const fake = setup();
    await fake.core.launch(launchBody(3));
    for (const id of ['agent-1', 'agent-2', 'agent-3'])
      await fake.core.handleEvent(agentEvent('agent.started', id, {}));
    await fake.core.handleEvent(agentEvent('agent.result', 'agent-1', { text: 'R' }));
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

  it('AC-022-18: agent.result не от входа — рой running; agent.result от входа — completed; agent.failed max_steps — swarm.failed agent_failed с detail', async () => {
    const fake = setup();
    await fake.core.launch(launchBody(3));
    for (const id of ['agent-1', 'agent-2', 'agent-3'])
      await fake.core.handleEvent(agentEvent('agent.started', id, {}));
    await fake.core.handleEvent(agentEvent('agent.result', 'agent-2', { text: 'X' }));
    expect(fake.sandboxes.size).toBe(3);
    expect(fake.events.some((e) => e.type === 'swarm.completed')).toBe(false);
    await fake.core.handleEvent(agentEvent('agent.result', 'agent-1', { text: 'R' }));
    expect(fake.events.at(-1)).toMatchObject({ type: 'swarm.completed', data: { result: 'R' } });

    const failing = setup();
    await failing.core.launch(launchBody(3));
    for (const id of ['agent-1', 'agent-2', 'agent-3'])
      await failing.core.handleEvent(agentEvent('agent.started', id, {}));
    await failing.core.handleEvent(agentEvent('agent.failed', 'agent-3', { reason: 'max_steps' }));
    expect(failing.sandboxes.size).toBe(0);
    expect(failing.events.filter((e) => e.type === 'agent.stopped')).toHaveLength(3);
    expect(failing.events.at(-1)).toMatchObject({
      type: 'swarm.failed',
      data: { reason: 'agent_failed', detail: 'agent-3: max_steps' },
    });
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

  it('AC-002-22: env песочниц роя не содержит ключей провайдеров и LiteLLM', async () => {
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

describe('orchestrator-core: регистрация роя в gateway (004, 4.6)', () => {
  it('AC-004-21: register до первого create; expiresAt = часы + swarmMs + 60 с; модели и бюджеты агентов из плана; при swarmMs 0 — null', async () => {
    const fake = setup({ swarmMs: 600000 });
    const body = {
      ...launchBody(2),
      agents: agents(2).map((agent, i) => (i === 0 ? { ...agent, budgetMicroUsd: 100000 } : agent)),
    };
    expect((await fake.core.launch(body)).ok).toBe(true);
    expect(fake.registrations).toEqual([
      {
        swarmId: SWARM,
        budgetMicroUsd: 500000,
        expiresAt: '2026-10-22T10:11:00.000Z',
        agents: [
          { agentId: 'agent-1', model: 'chat-small', budgetMicroUsd: 100000 },
          { agentId: 'agent-2', model: 'chat-small', budgetMicroUsd: null },
        ],
      },
    ]);
    expect(fake.log.indexOf('gateway:register')).toBeLessThan(fake.log.indexOf('sandbox:create'));

    const unlimited = setup({ swarmMs: 0 });
    await unlimited.core.launch(launchBody(1));
    expect(unlimited.registrations[0]?.expiresAt).toBeNull();
  });

  it('AC-004-22: register бросает — swarm.failed gateway_unavailable с detail, create не вызван, песочниц нет', async () => {
    const fake = setup({ registerError: new Error('gateway down') });
    const result = await fake.core.launch(launchBody(2));
    expect(result.ok).toBe(true);
    expect(fake.log).not.toContain('sandbox:create');
    expect(fake.sandboxes.size).toBe(0);
    expect(fake.events.at(-1)).toMatchObject({
      type: 'swarm.failed',
      data: { reason: 'gateway_unavailable', detail: 'gateway down' },
    });
    expect(fake.closed).toEqual([SWARM]);
  });

  it('AC-004-23: итог completed, stopped, swarm_timeout и agent_failed — close один раз после уборки песочниц и до итогового события', async () => {
    const endings: { name: string; final: string; run: (fake: Fake) => Promise<void> }[] = [
      {
        name: 'completed',
        final: 'swarm.completed',
        run: (fake) => fake.core.handleEvent(agentEvent('agent.result', 'agent-1', { text: 'R' })),
      },
      {
        name: 'stopped',
        final: 'swarm.stopped',
        run: async (fake) => {
          await fake.core.stop(SWARM);
        },
      },
      {
        name: 'swarm_timeout',
        final: 'swarm.failed',
        run: async (fake) => {
          fake.runTimers(300000);
          await waitMicrotasks();
        },
      },
      {
        name: 'agent_failed',
        final: 'swarm.failed',
        run: (fake) =>
          fake.core.handleEvent(agentEvent('agent.failed', 'agent-2', { reason: 'max_steps' })),
      },
    ];
    for (const ending of endings) {
      const fake = setup();
      await fake.core.launch(launchBody(2));
      for (const id of ['agent-1', 'agent-2'])
        await fake.core.handleEvent(agentEvent('agent.started', id, {}));
      await ending.run(fake);
      expect(fake.closed, ending.name).toEqual([SWARM]);
      const closeAt = fake.log.indexOf('gateway:close');
      expect(fake.log.lastIndexOf('sandbox:remove'), ending.name).toBeLessThan(closeAt);
      expect(closeAt, ending.name).toBeLessThan(fake.log.indexOf(`event:${ending.final}`));
    }
  });

  it('stop во время регистрации: без песочниц и таймеров, рой закрыт', async () => {
    let release!: () => void;
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fake = setup({ registerHold: hold, swarmMs: 300000 });
    const launching = fake.core.launch(launchBody(2));
    await waitMicrotasks();
    expect((await fake.core.stop(SWARM)).ok).toBe(true);
    release();
    expect((await launching).ok).toBe(true);
    expect(fake.log).not.toContain('sandbox:create');
    expect(fake.sandboxes.size).toBe(0);
    fake.runTimers(300000);
    await waitMicrotasks();
    expect(fake.closed).toEqual([SWARM, SWARM]);
    expect(fake.events.filter((e) => e.type === 'swarm.stopped')).toHaveLength(1);
    expect(fake.events.filter((e) => e.type === 'swarm.failed')).toHaveLength(0);
    expect(fake.events.at(-1)).toMatchObject({ type: 'swarm.stopped' });
  });

  it('AC-004-23: close бросает — лог warn gateway_close_failed, итоговое событие опубликовано', async () => {
    const closeError = new Error('gateway 500');
    const fake = setup({ closeError });
    await fake.core.launch(launchBody(1));
    await fake.core.handleEvent(agentEvent('agent.started', 'agent-1', {}));
    await fake.core.stop(SWARM);
    expect(fake.entries).toContainEqual({
      level: 'warn',
      msg: 'gateway_close_failed',
      ctx: { swarmId: SWARM, err: closeError },
    });
    expect(fake.events.at(-1)).toMatchObject({ type: 'swarm.stopped' });
  });

  it('AC-004-24: agent.failed с model_error:swarm_budget_exceeded и model_error:agent_budget_exceeded — swarm.failed budget_exceeded, песочницы убраны; прочие model_error — agent_failed', async () => {
    for (const code of ['swarm_budget_exceeded', 'agent_budget_exceeded']) {
      const fake = setup();
      await fake.core.launch(launchBody(3));
      for (const id of ['agent-1', 'agent-2', 'agent-3'])
        await fake.core.handleEvent(agentEvent('agent.started', id, {}));
      await fake.core.handleEvent(
        agentEvent('agent.failed', 'agent-2', { reason: `model_error:${code}` }),
      );
      expect(fake.events.at(-1)).toMatchObject({
        type: 'swarm.failed',
        data: { reason: 'budget_exceeded', detail: `agent-2: ${code}` },
      });
      expect(fake.sandboxes.size).toBe(0);
    }

    const other = setup();
    await other.core.launch(launchBody(2));
    for (const id of ['agent-1', 'agent-2'])
      await other.core.handleEvent(agentEvent('agent.started', id, {}));
    await other.core.handleEvent(
      agentEvent('agent.failed', 'agent-2', { reason: 'model_error:upstream_timeout' }),
    );
    expect(other.events.at(-1)).toMatchObject({
      type: 'swarm.failed',
      data: { reason: 'agent_failed', detail: 'agent-2: model_error:upstream_timeout' },
    });
  });
});

describe('orchestrator-core: токен шлюза (спека 004, AC-004-33)', () => {
  it('AC-004-33: launch и finish — токен попадает только в env песочниц; в логах, событиях и сообщениях шины его нет', async () => {
    const fake = setup();
    expect((await fake.core.launch(launchBody(2))).ok).toBe(true);
    // Проверка не пустая: токен реально ушёл в песочницы, рой зарегистрирован в gateway.
    expect([...fake.sandboxes.values()].map((spec) => spec.env['LLM_GATEWAY_TOKEN'])).toEqual([
      LLM_TOKEN,
      LLM_TOKEN,
    ]);
    expect(fake.registrations).toHaveLength(1);

    expect((await fake.core.stop(SWARM)).ok).toBe(true);
    expect(fake.closed).toEqual([SWARM]);
    expect(fake.events.at(-1)).toMatchObject({ type: 'swarm.stopped' });

    const dump = JSON.stringify({
      logs: fake.entries,
      events: fake.events,
      messages: fake.messages,
      registrations: fake.registrations,
    });
    expect(dump).not.toContain(LLM_TOKEN);
  });
});

// Даём отработать асинхронным обработчикам после срабатывания таймера.
async function waitMicrotasks(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
}

describe('orchestrator-core: AC-031-4 — AGENT_MAX_TOKENS агента, роя или умолчания', () => {
  it('AC-031-4: агент с maxTokens 16384 и агент без значения при maxTokens роя 4096 — env 16384 и 4096', async () => {
    const fake = setup({ agentMaxTokens: 8192 });
    const body = {
      ...launchBody(2),
      maxTokens: 4096,
      agents: agents(2).map((agent, i) => (i === 0 ? { ...agent, maxTokens: 16384 } : agent)),
    };
    expect((await fake.core.launch(body)).ok).toBe(true);
    expect([...fake.sandboxes.values()].map((s) => s.env['AGENT_MAX_TOKENS'])).toEqual([
      '16384',
      '4096',
    ]);
  });

  it('AC-031-4: без значения у агента и роя — AGENT_MAX_TOKENS умолчания оркестратора 8192', async () => {
    const fake = setup({ agentMaxTokens: 8192 });
    expect((await fake.core.launch(launchBody(1))).ok).toBe(true);
    expect([...fake.sandboxes.values()].map((s) => s.env['AGENT_MAX_TOKENS'])).toEqual(['8192']);
  });
});

describe('orchestrator-core: траты роя из gateway (013, 4.6)', () => {
  const runTo = async (
    options: Parameters<typeof setup>[0],
    ending: (fake: Fake) => Promise<unknown>,
  ): Promise<Fake> => {
    const fake = setup(options);
    await fake.core.launch(launchBody(2));
    for (const id of ['agent-1', 'agent-2'])
      await fake.core.handleEvent(agentEvent('agent.started', id, {}));
    await ending(fake);
    return fake;
  };
  const completed = (fake: Fake) =>
    fake.core.handleEvent(agentEvent('agent.result', 'agent-1', { text: 'R' }));
  const stopped = (fake: Fake) => fake.core.stop(SWARM);
  const failed = (fake: Fake) =>
    fake.core.handleEvent(agentEvent('agent.failed', 'agent-2', { reason: 'max_steps' }));

  it('AC-013-19: close вернул 4200 — spentMicroUsd в data swarm.completed, swarm.stopped и swarm.failed', async () => {
    const done = await runTo({ closeSpent: 4200 }, completed);
    expect(done.events.at(-1)).toMatchObject({
      type: 'swarm.completed',
      data: { result: 'R', spentMicroUsd: 4200 },
    });
    const halted = await runTo({ closeSpent: 4200 }, stopped);
    expect(halted.events.at(-1)).toMatchObject({
      type: 'swarm.stopped',
      data: { reason: 'user', spentMicroUsd: 4200 },
    });
    const broken = await runTo({ closeSpent: 4200 }, failed);
    expect(broken.events.at(-1)).toMatchObject({
      type: 'swarm.failed',
      data: { reason: 'agent_failed', spentMicroUsd: 4200 },
    });
  });

  it('AC-013-19: close бросил исключение — поля нет, рой завершён swarm.stopped', async () => {
    const fake = await runTo({ closeError: new Error('gateway 500') }, stopped);
    const final = fake.events.at(-1);
    expect(final).toMatchObject({ type: 'swarm.stopped', data: { reason: 'user' } });
    expect(final?.data).not.toHaveProperty('spentMicroUsd');
  });

  it('AC-013-19: close вернул null (404) — поля нет, рой завершён', async () => {
    const fake = await runTo({ closeSpent: null }, completed);
    const final = fake.events.at(-1);
    expect(final).toMatchObject({ type: 'swarm.completed', data: { result: 'R' } });
    expect(final?.data).not.toHaveProperty('spentMicroUsd');
  });
});

// Спека 009, 4.6: граф процесса. Программы исполняются через фейки портов узлов (026): песочница отвечает на кадры,
// NodeStateStore показывает stateKey вызова. Агенты — как в форме.
type Edge = { from: string; to: string; kind: 'flow' | 'link' };
type Program = {
  id: string;
  type: string;
  settings: Record<string, unknown>;
  credentials: Record<string, string>;
  stateKey?: string;
};

const ECHO = 'example/echo@1.0.0';
const KEYED = 'example/keyed@1.0.0';
const program = (
  id: string,
  settings: Record<string, unknown> = { prefix: '' },
  credentials: Record<string, string> = {},
  type = ECHO,
): Program => ({ id, type, settings, credentials });
const graphBody = (graph: {
  agents: string[];
  programs: Program[];
  edges: Edge[];
  entry: string;
  exit: string;
  task?: string;
}) => ({
  swarmId: SWARM,
  orgId: ORG,
  task: graph.task ?? 'T',
  budgetMicroUsd: 500000,
  maxTokens: null,
  agents: graph.agents.map((id) => ({ id, name: `N-${id}`, role: `r-${id}` })),
  programs: graph.programs,
  edges: graph.edges,
  entry: graph.entry,
  exit: graph.exit,
});
// Программа p → команда a—b → агент c: вход p, выход c (AC-009-17).
const CHAIN = {
  agents: ['a', 'b', 'c'],
  programs: [program('p')],
  edges: [
    { from: 'p', to: 'a', kind: 'flow' },
    { from: 'a', to: 'c', kind: 'flow' },
    { from: 'a', to: 'b', kind: 'link' },
  ] as Edge[],
  entry: 'p',
  exit: 'c',
};
// Команда a—b на входе, выход команды передаётся программе q (выход — шаг-выход).
const TEAM_TO_PROGRAM = {
  agents: ['a', 'b'],
  programs: [program('q')],
  edges: [
    { from: 'a', to: 'b', kind: 'link' },
    { from: 'a', to: 'q', kind: 'flow' },
  ] as Edge[],
  entry: 'a',
  exit: 'q',
};
// Программа p → a и p → q (боковая ветка), команда a—b с выходом a.
const SIDE = {
  agents: ['a', 'b'],
  programs: [program('p'), program('q', { prefix: 'q' })],
  edges: [
    { from: 'p', to: 'a', kind: 'flow' },
    { from: 'p', to: 'q', kind: 'flow' },
    { from: 'a', to: 'b', kind: 'link' },
  ] as Edge[],
  entry: 'p',
  exit: 'a',
};

const OUT = { text: 'x' };
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
const answer =
  (output: unknown): Respond =>
  (frame, emit) => {
    if (frame.t === 'invoke') emit.frame({ t: 'result', ok: true, output });
  };
// Программа пишет состояние под своим stateKey, затем отвечает: NodeStateStore видит stateKey роя.
const stateThenAnswer =
  (output: unknown): Respond =>
  (frame, emit) => {
    if (frame.t === 'invoke') emit.frame({ t: 'state.set', id: 1, key: 'k', value: 'v' });
    if (frame.t === 'state') emit.frame({ t: 'result', ok: true, output });
  };
const failWith =
  (code: string, message: string): Respond =>
  (frame, emit) => {
    if (frame.t === 'invoke') emit.frame({ t: 'result', ok: false, code, message });
  };
// Ответ программы q приходит, когда resolve; остальные программы отвечают сразу.
const slowSide =
  (slow: { promise: Promise<unknown> }): Respond =>
  (frame, emit) => {
    if (frame.t !== 'invoke') return;
    if (frame.settings['prefix'] === 'q')
      void slow.promise.then((output) => emit.frame({ t: 'result', ok: true, output }));
    else emit.frame({ t: 'result', ok: true, output: OUT });
  };
const invokeOf = (fake: Fake) =>
  fake.node.sandboxes.hostFrames.get('node-1')?.find((frame) => frame.t === 'invoke');

type SetupOptions = NonNullable<Parameters<typeof setup>[0]>;
const graphSetup = (options: SetupOptions = {}): Fake =>
  setup({ respond: answer(OUT), ...options });

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function startAll(fake: Fake, ids: string[]): Promise<void> {
  for (const id of ids) await fake.core.handleEvent(agentEvent('agent.started', id, {}));
}

describe('orchestrator-core: граф процесса (спека 009, 4.6)', () => {
  it('AC-009-16: форма из 2 агентов — события в том же порядке, env агентов, итог finish agent-1', async () => {
    const fake = setup();
    expect((await fake.core.launch(launchBody(2))).ok).toBe(true);
    const [first, second] = [...fake.sandboxes.values()];
    expect(first?.env['AGENT_ENTRY']).toBe('agent-1');
    expect(second?.env['AGENT_ENTRY']).toBe('agent-1');
    expect(first?.env['AGENT_TASK_FROM']).toBe('user');
    expect(first?.env['AGENT_RESULT_TO']).toBe('user');
    expect(second?.env['AGENT_TASK_FROM']).toBeUndefined();
    expect(JSON.parse(first?.env['AGENT_PEERS'] ?? '[]')).toEqual([
      { id: 'agent-2', name: 'A2', role: 'r2' },
    ]);
    expect(JSON.parse(second?.env['AGENT_PEERS'] ?? '[]')).toEqual([
      { id: 'agent-1', name: 'A1', role: 'r1' },
    ]);
    await startAll(fake, ['agent-1', 'agent-2']);
    await fake.core.handleEvent(agentEvent('agent.result', 'agent-1', { text: 'R' }));
    expect(fake.log).toEqual([
      'gateway:register',
      'sandbox:create',
      'event:agent.launched',
      'sandbox:create',
      'event:agent.launched',
      'message:agent-1',
      'event:swarm.started',
      'sandbox:remove',
      'sandbox:remove',
      'event:agent.stopped',
      'event:agent.stopped',
      'gateway:close',
      'event:swarm.completed',
    ]);
  });

  it('REQ-009-8, REQ-009-16: граф CHAIN — env агентов: вход a получает шаг-источник p и выход в процесс, b без ключей входа, выход c — пользователю', async () => {
    const fake = graphSetup();
    expect((await fake.core.launch(graphBody(CHAIN))).ok).toBe(true);
    const envOf = (agentId: string): Record<string, string> =>
      [...fake.sandboxes.values()].find((spec) => spec.metadata['swag.agent'] === agentId)?.env ??
      {};
    const peersOf = (agentId: string): unknown => JSON.parse(envOf(agentId)['AGENT_PEERS'] ?? '[]');
    expect(envOf('a')).toMatchObject({
      AGENT_ENTRY: 'a',
      AGENT_TASK_FROM: 'p',
      AGENT_RESULT_TO: 'process',
    });
    expect(peersOf('a')).toEqual([{ id: 'b', name: 'N-b', role: 'r-b' }]);
    expect(envOf('b')).toMatchObject({ AGENT_ENTRY: 'a' });
    expect(envOf('b')).not.toHaveProperty('AGENT_TASK_FROM');
    expect(envOf('b')).not.toHaveProperty('AGENT_RESULT_TO');
    expect(peersOf('b')).toEqual([{ id: 'a', name: 'N-a', role: 'r-a' }]);
    expect(envOf('c')).toMatchObject({
      AGENT_ENTRY: 'c',
      AGENT_TASK_FROM: 'a',
      AGENT_RESULT_TO: 'user',
    });
    expect(peersOf('c')).toEqual([]);
  });

  it('AC-009-18: программа-вход получает { text: task } со stateKey роя; сообщение a от p; swarm.started после передачи', async () => {
    const fake = graphSetup({ respond: stateThenAnswer(OUT) });
    expect((await fake.core.launch(graphBody(CHAIN))).ok).toBe(true);
    await startAll(fake, ['a', 'b']);
    const mark = fake.log.length;
    await fake.core.handleEvent(agentEvent('agent.started', 'c', {}));
    expect(fake.log.slice(mark)).toEqual([
      'event:node.started',
      'event:node.completed',
      'message:a',
      'event:swarm.started',
    ]);
    expect(invokeOf(fake)).toMatchObject({
      call: { kind: 'execute', input: { text: 'T' } },
      settings: { prefix: '' },
    });
    expect(fake.node.stateSets).toEqual([
      expect.objectContaining({ orgId: ORG, stateKey: `swarm:${SWARM}:p` }),
    ]);
    expect(fake.messages).toHaveLength(1);
    expect(fake.messages[0]).toMatchObject({ from: 'p', to: 'a', text: 'x' });
  });

  it('AC-009-19: agent.result входа команды — песочницы a и b убраны с agent.stopped, c получает from a; swarm.completed по выходу c', async () => {
    const fake = graphSetup();
    expect((await fake.core.launch(graphBody(CHAIN))).ok).toBe(true);
    await startAll(fake, ['a', 'b', 'c']);
    const eventsMark = fake.events.length;
    await fake.core.handleEvent(agentEvent('agent.result', 'a', { text: 'r1' }));
    expect(fake.events.slice(eventsMark)).toMatchObject([
      { type: 'agent.stopped', agentId: 'a' },
      { type: 'agent.stopped', agentId: 'b' },
    ]);
    expect(fake.messages.at(-1)).toMatchObject({ from: 'a', to: 'c', text: 'r1' });
    expect([...fake.sandboxes.values()].map((spec) => spec.metadata['swag.agent'])).toEqual(['c']);
    expect(fake.events.some((e) => e.type === 'swarm.completed')).toBe(false);
    await fake.core.handleEvent(agentEvent('agent.result', 'c', { text: 'r2' }));
    expect(fake.events.at(-1)).toMatchObject({ type: 'swarm.completed', data: { result: 'r2' } });
  });

  it('AC-009-20: программа ответила invalid_output — node.failed и swarm.failed node_failed с detail p: invalid_output', async () => {
    const fake = graphSetup({ respond: failWith('invalid_output', 'истекло') });
    expect((await fake.core.launch(graphBody(CHAIN))).ok).toBe(true);
    await startAll(fake, ['a', 'b', 'c']);
    expect(fake.events.find((e) => e.type === 'node.failed')).toMatchObject({
      type: 'node.failed',
      data: { nodeId: 'p', code: 'invalid_output', message: 'истекло' },
    });
    expect(fake.events.some((e) => e.type === 'node.completed')).toBe(false);
    expect(fake.messages).toHaveLength(0);
    expect(fake.events.at(-1)).toMatchObject({
      type: 'swarm.failed',
      data: { reason: 'node_failed', detail: 'p: invalid_output' },
    });
  });

  it('AC-009-21: шаг-выход завершён, программа в боковой ветке ещё идёт — swarm.completed не приходит до её ответа', async () => {
    const slow = deferred<unknown>();
    const fake = graphSetup({ respond: slowSide(slow) });
    expect((await fake.core.launch(graphBody(SIDE))).ok).toBe(true);
    await startAll(fake, ['a', 'b']);
    await fake.core.handleEvent(agentEvent('agent.result', 'a', { text: 'R' }));
    expect(fake.events.some((e) => e.type === 'swarm.completed')).toBe(false);
    slow.resolve({ text: 'Q' });
    await flush();
    expect(fake.events.at(-1)).toMatchObject({ type: 'swarm.completed', data: { result: 'R' } });
  });

  it('AC-009-21: stop при идущей программе — ответ программы после swarm.stopped не даёт событий', async () => {
    const slow = deferred<unknown>();
    const fake = graphSetup({ respond: slowSide(slow) });
    expect((await fake.core.launch(graphBody(SIDE))).ok).toBe(true);
    await startAll(fake, ['a', 'b']);
    await fake.core.stop(SWARM);
    const mark = fake.events.length;
    slow.resolve({ text: 'Q' });
    await flush();
    expect(fake.events.length).toBe(mark);
    expect(fake.events.at(-1)).toMatchObject({ type: 'swarm.stopped' });
  });

  it('AC-009-22: agent.result агента команды, который не агент-вход, — шаг не завершается, событий и песочниц нет', async () => {
    const fake = graphSetup();
    expect((await fake.core.launch(graphBody(CHAIN))).ok).toBe(true);
    await startAll(fake, ['a', 'b', 'c']);
    const eventsMark = fake.events.length;
    await fake.core.handleEvent(agentEvent('agent.result', 'b', { text: 'x' }));
    expect(fake.events.length).toBe(eventsMark);
    expect(fake.sandboxes.size).toBe(3);
    expect(fake.messages).toHaveLength(1);
  });

  it('REQ-009-10: выход команды запускает программу через plan.next — вход { text: выход команды }, выход программы — swarm.completed', async () => {
    const fake = graphSetup({ respond: stateThenAnswer({ text: 'done' }) });
    expect((await fake.core.launch(graphBody(TEAM_TO_PROGRAM))).ok).toBe(true);
    await startAll(fake, ['a', 'b']);
    expect(fake.messages[0]).toMatchObject({ from: 'user', to: 'a', text: 'T' });
    await fake.core.handleEvent(agentEvent('agent.result', 'a', { text: 'r1' }));
    await flush();
    expect(invokeOf(fake)).toMatchObject({ call: { kind: 'execute', input: { text: 'r1' } } });
    expect(fake.events.at(-1)).toMatchObject({
      type: 'swarm.completed',
      data: { result: 'done' },
    });
  });

  it('AC-009-26: маркеры настроек программы и задачи не попадают в события и логи оркестратора', async () => {
    const fake = graphSetup();
    const body = graphBody({
      ...CHAIN,
      programs: [program('p', { prefix: 'settings-marker-009' })],
      task: 'input-marker-009',
    });
    expect((await fake.core.launch(body)).ok).toBe(true);
    await startAll(fake, ['a', 'b', 'c']);
    await fake.core.handleEvent(agentEvent('agent.result', 'a', { text: 'r1' }));
    await fake.core.handleEvent(agentEvent('agent.result', 'c', { text: 'r2' }));
    expect(fake.events.at(-1)).toMatchObject({ type: 'swarm.completed' });
    const dump = JSON.stringify({ events: fake.events, logs: fake.entries });
    expect(dump).not.toContain('settings-marker-009');
    expect(dump).not.toContain('input-marker-009');
  });

  it('REQ-009-13, AC-009-26: ветка отказа — node.failed несёт код и текст ошибки узла, без настроек и задачи в логах', async () => {
    const fake = graphSetup({ respond: failWith('invalid_output', 'истекло') });
    const body = graphBody({
      ...CHAIN,
      programs: [program('p', { prefix: 'settings-marker-009' })],
      task: 'input-marker-009',
    });
    expect((await fake.core.launch(body)).ok).toBe(true);
    await startAll(fake, ['a', 'b', 'c']);
    expect(fake.events.at(-1)).toMatchObject({
      type: 'swarm.failed',
      data: { reason: 'node_failed', detail: 'p: invalid_output' },
    });
    const dump = JSON.stringify({ events: fake.events, logs: fake.entries });
    expect(dump).not.toContain('settings-marker-009');
    expect(dump).not.toContain('input-marker-009');
  });

  it('stop во время публикации node.started — вызов программы не выполняется, событий после swarm.stopped нет', async () => {
    const fake: Fake = graphSetup({
      onEvent: async (event) => {
        if (event.type === 'node.started') await fake.core.stop(SWARM);
      },
    });
    expect((await fake.core.launch(graphBody(CHAIN))).ok).toBe(true);
    await startAll(fake, ['a', 'b', 'c']);
    expect(fake.node.sandboxes.runs).toHaveLength(0);
    expect(fake.events.some((e) => e.type === 'node.completed')).toBe(false);
    expect(fake.events.at(-1)).toMatchObject({ type: 'swarm.stopped' });
  });

  it('stop во время уборки команды — у каждого агента ровно один agent.stopped', async () => {
    const gate = deferred<void>();
    const fake = graphSetup({ removeGate: gate.promise });
    expect((await fake.core.launch(graphBody(CHAIN))).ok).toBe(true);
    await startAll(fake, ['a', 'b', 'c']);
    const team = fake.core.handleEvent(agentEvent('agent.result', 'a', { text: 'r1' }));
    const stopping = fake.core.stop(SWARM);
    await flush();
    gate.resolve();
    await Promise.all([team, stopping]);
    const stopped = fake.events
      .filter((e) => e.type === 'agent.stopped')
      .map((e) => e.agentId)
      .sort();
    expect(stopped).toEqual(['a', 'b', 'c']);
  });

  it('исключение при публикации в фоновой программе — swarm.failed node_failed с detail q: node_failed', async () => {
    const fake = graphSetup({
      onEvent: async (event) => {
        if (event.type === 'node.started' && event.data.nodeId === 'q') {
          throw new Error('шина недоступна');
        }
      },
    });
    expect((await fake.core.launch(graphBody(SIDE))).ok).toBe(true);
    await startAll(fake, ['a', 'b']);
    await flush();
    expect(fake.events.at(-1)).toMatchObject({
      type: 'swarm.failed',
      data: { reason: 'node_failed', detail: 'q: node_failed' },
    });
    expect(fake.entries.find((e) => e.msg === 'program step failed')?.ctx).toMatchObject({
      swarmId: SWARM,
      nodeId: 'q',
    });
  });

  it('исключение при публикации у программы-входа (checkReady) — swarm.failed node_failed с detail p: node_failed', async () => {
    const fake = graphSetup({
      onEvent: async (event) => {
        if (event.type === 'node.started' && event.data.nodeId === 'p') {
          throw new Error('шина недоступна');
        }
      },
    });
    expect((await fake.core.launch(graphBody(CHAIN))).ok).toBe(true);
    await startAll(fake, ['a', 'b', 'c']);
    expect(fake.node.sandboxes.runs).toHaveLength(0);
    expect(fake.events.at(-1)).toMatchObject({
      type: 'swarm.failed',
      data: { reason: 'node_failed', detail: 'p: node_failed' },
    });
  });

  it('D-185: исключение при вызове программы — node.failed и swarm.failed node_failed; в логе только имя ошибки', async () => {
    const fake = graphSetup({
      secrets: {
        read: async () => {
          throw new Error('хранилище недоступно');
        },
      },
    });
    const body = graphBody({
      ...CHAIN,
      programs: [program('p', {}, { apiKey: 'avito_token' }, KEYED)],
    });
    expect((await fake.core.launch(body)).ok).toBe(true);
    await startAll(fake, ['a', 'b', 'c']);
    expect(fake.events.find((e) => e.type === 'node.failed')).toMatchObject({
      data: { nodeId: 'p', code: 'node_failed', message: 'Сбой вызова программы' },
    });
    expect(fake.events.at(-1)).toMatchObject({
      type: 'swarm.failed',
      data: { reason: 'node_failed', detail: 'p: node_failed' },
    });
    expect(fake.entries.find((e) => e.msg === 'node invoke threw')?.ctx).toEqual({
      swarmId: SWARM,
      nodeId: 'p',
      errorName: 'Error',
    });
  });
});

describe('orchestrator-core: запуск по триггеру и stateKey программ (спека 033, 4.2)', () => {
  it('AC-033-7: без trigger и stateKey — trigger разбирается в null, программа со stateKey swarm:<id>:<nodeId>; программа со stateKey process:c:x — вызов с ним', async () => {
    expect(SwarmLaunch.parse({ ...graphBody(CHAIN), programs: [] }).trigger).toBeNull();

    const fake = graphSetup({ respond: stateThenAnswer(OUT) });
    expect((await fake.core.launch(graphBody(CHAIN))).ok).toBe(true);
    await startAll(fake, ['a', 'b', 'c']);
    expect(fake.node.stateSets).toEqual([
      expect.objectContaining({ stateKey: `swarm:${SWARM}:p` }),
    ]);

    const keyed = graphSetup({ respond: stateThenAnswer(OUT) });
    const body = graphBody({ ...CHAIN, programs: [{ ...program('p'), stateKey: 'process:c:x' }] });
    expect((await keyed.core.launch(body)).ok).toBe(true);
    await startAll(keyed, ['a', 'b', 'c']);
    expect(keyed.node.stateSets).toEqual([expect.objectContaining({ stateKey: 'process:c:x' })]);
  });

  it('AC-033-8: trigger с шагом-входом-программой — execute со входом trigger.event, после старта всех агентов', async () => {
    const fake = graphSetup();
    const body = { ...graphBody(CHAIN), trigger: { nodeId: 't', event: { text: 'x' } } };
    expect((await fake.core.launch(body)).ok).toBe(true);
    await startAll(fake, ['a', 'b']);
    expect(invokeOf(fake)).toBeUndefined();
    await fake.core.handleEvent(agentEvent('agent.started', 'c', {}));
    expect(invokeOf(fake)).toMatchObject({ call: { kind: 'execute', input: { text: 'x' } } });
  });

  it('AC-033-8: trigger с шагом-входом-командой — сообщение от t агенту-входу a, AGENT_TASK_FROM=t у a', async () => {
    const fake = graphSetup();
    const team = graphBody({
      agents: ['a', 'b'],
      programs: [],
      edges: [{ from: 'a', to: 'b', kind: 'link' }],
      entry: 'a',
      exit: 'a',
    });
    expect(
      (await fake.core.launch({ ...team, trigger: { nodeId: 't', event: { n: 1 } } })).ok,
    ).toBe(true);
    await startAll(fake, ['a', 'b']);
    expect(fake.messages).toEqual([
      expect.objectContaining({ from: 't', to: 'a', text: '{"n":1}' }),
    ]);
    const envOf = (agentId: string): Record<string, string> =>
      [...fake.sandboxes.values()].find((spec) => spec.metadata['swag.agent'] === agentId)?.env ??
      {};
    expect(envOf('a')).toMatchObject({ AGENT_ENTRY: 'a', AGENT_TASK_FROM: 't' });
    expect(envOf('b')).not.toHaveProperty('AGENT_TASK_FROM');
  });
});
