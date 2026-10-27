import { describe, expect, it, vi } from 'vitest';
import { createMemorySwarmStore } from '@swag/adapter-memory';
import type { PlatformEventInput, SwarmLaunch } from '@swag/contracts';
import {
  createApiCore,
  type LogContext,
  type Logger,
  type OrchestratorClient,
} from '../src/index.ts';

const uuid = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const body = (count: number) => ({
  task: 'Задача',
  agents: Array.from({ length: count }, (_, i) => ({
    name: `Агент ${i + 1}`,
    role: `роль ${i + 1}`,
  })),
});

const T1 = '11111111111111111111111111111111';
const T2 = '22222222222222222222222222222222';
const T3 = '33333333333333333333333333333333';

interface Entry {
  level: 'debug' | 'info' | 'warn' | 'error';
  msg: string;
  ctx?: LogContext;
}

function setup(options: { launch?: () => Promise<void>; maxActiveSwarms?: number } = {}) {
  let counter = 0;
  const launches: SwarmLaunch[] = [];
  const stops: string[] = [];
  const entries: Entry[] = [];
  const logs: string[] = [];
  const at =
    (level: Entry['level']) =>
    (msg: string, ctx?: LogContext): void => {
      entries.push(ctx === undefined ? { level, msg } : { level, msg, ctx });
      logs.push(msg);
    };
  const log: Logger = {
    debug: at('debug'),
    info: at('info'),
    warn: at('warn'),
    error: at('error'),
  };
  const traceState = { current: T1 as string | null };
  const orchestrator: OrchestratorClient = {
    launch: vi.fn(async (launch: SwarmLaunch) => {
      launches.push(launch);
      if (options.launch) await options.launch();
    }),
    stop: vi.fn(async (id: string) => {
      stops.push(id);
    }),
  };
  const core = createApiCore({
    version: 'test',
    store: createMemorySwarmStore(),
    orchestrator,
    clock: { now: () => '2026-10-22T10:00:00.000Z' },
    ids: { uuid: () => uuid(++counter) },
    log,
    trace: { currentTraceId: () => traceState.current },
    limits: { maxActiveSwarms: options.maxActiveSwarms ?? 3 },
  });
  return { core, launches, stops, logs, entries, traceState };
}

const sys = (
  swarmId: string,
  n: number,
  input: Omit<PlatformEventInput, 'id' | 'swarmId' | 'ts' | 'traceId'>,
): PlatformEventInput =>
  ({
    ...input,
    id: uuid(9000 + n),
    swarmId,
    ts: '2026-10-22T10:00:01.000Z',
    traceId: null,
  }) as PlatformEventInput;

describe('api-core', () => {
  it('AC-000-16: info() возвращает ServiceInfo сервиса api с версией из оболочки', () => {
    const { core } = setup();
    expect(core.info()).toEqual({ service: 'api', version: 'test' });
  });

  it('AC-001-3: создание роя из трёх агентов — 201-эквивалент, agent-1..3, launch с тем же swarmId, событие swarm.created с seq 1', async () => {
    const { core, launches } = setup();
    const result = await core.createSwarm(body(3));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.status).toBe('starting');
    expect(result.value.agents.map((a) => a.id)).toEqual(['agent-1', 'agent-2', 'agent-3']);
    expect(launches).toHaveLength(1);
    expect(launches[0]?.swarmId).toBe(result.value.id);
    const events = core.getEvents(result.value.id, 0);
    expect(events.ok && events.value.map((e) => [e.type, e.seq])).toEqual([['swarm.created', 1]]);
  });

  it('AC-001-4: невалидное тело — validation_error с путём поля', async () => {
    const { core } = setup();
    const result = await core.createSwarm({ task: 'x', agents: [{ name: 'a', role: '' }] });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('validation_error');
    expect(result.error.issues?.[0]?.path).toBe('agents.0.role');
  });

  it('AC-001-5: лимит активных роёв; после swarm.completed новый рой создаётся', async () => {
    const { core } = setup({ maxActiveSwarms: 1 });
    const first = await core.createSwarm(body(1));
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const second = await core.createSwarm(body(1));
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.error.code).toBe('too_many_active_swarms');

    const id = first.value.id;
    core.ingestEvent(
      sys(id, 1, { type: 'swarm.started', source: 'orchestrator', agentId: null, data: {} }),
    );
    core.ingestEvent(
      sys(id, 2, {
        type: 'swarm.completed',
        source: 'orchestrator',
        agentId: null,
        data: { result: 'R' },
      }),
    );
    const third = await core.createSwarm(body(1));
    expect(third.ok).toBe(true);
  });

  it('AC-001-6: оркестратор недоступен — 201-эквивалент и статус failed с orchestrator_unavailable', async () => {
    const { core } = setup({
      launch: async () => {
        throw new Error('connect ECONNREFUSED');
      },
    });
    const result = await core.createSwarm(body(2));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const view = core.getSwarm(result.value.id);
    expect(view.ok && view.value.status).toBe('failed');
    expect(view.ok && view.value.failure?.reason).toBe('orchestrator_unavailable');
  });

  it('AC-001-7: события получают seq 2, 3… без пропусков, сообщение становится bus.message, after=1 отдаёт всё кроме первого', async () => {
    const { core } = setup();
    const created = await core.createSwarm(body(2));
    if (!created.ok) throw new Error('не создан');
    const id = created.value.id;
    core.ingestEvent(
      sys(id, 1, { type: 'swarm.started', source: 'orchestrator', agentId: null, data: {} }),
    );
    core.ingestEvent(
      sys(id, 2, { type: 'agent.started', source: 'agent', agentId: 'agent-1', data: {} }),
    );
    core.ingestMessage({
      id: uuid(8001),
      swarmId: id,
      from: 'user',
      to: 'agent-1',
      text: 'T',
      ts: '2026-10-22T10:00:02.000Z',
    });
    const events = core.getEvents(id, 0);
    if (!events.ok) throw new Error('нет событий');
    expect(events.value.map((e) => e.seq)).toEqual([1, 2, 3, 4]);
    const message = events.value[3];
    expect(message?.type).toBe('bus.message');
    expect(message && message.type === 'bus.message' && message.data).toMatchObject({
      from: 'user',
      to: 'agent-1',
      text: 'T',
    });
    const after = core.getEvents(id, 1);
    expect(after.ok && after.value.map((e) => e.seq)).toEqual([2, 3, 4]);
  });

  it('AC-001-8: невалидные события и сообщения, а также событие неизвестного роя, не сохраняются; следующее валидное обрабатывается', async () => {
    const { core, logs } = setup();
    const created = await core.createSwarm(body(1));
    if (!created.ok) throw new Error('не создан');
    const id = created.value.id;
    core.ingestEvent({ type: 'мусор' });
    core.ingestMessage({ id: 'не-uuid' });
    core.ingestEvent(
      sys(uuid(7777), 3, {
        type: 'swarm.started',
        source: 'orchestrator',
        agentId: null,
        data: {},
      }),
    );
    expect(logs.length).toBeGreaterThanOrEqual(3);
    core.ingestEvent(
      sys(id, 4, { type: 'swarm.started', source: 'orchestrator', agentId: null, data: {} }),
    );
    const events = core.getEvents(id, 0);
    expect(events.ok && events.value.map((e) => e.seq)).toEqual([1, 2]);
  });

  it('AC-001-10: остановка running — stop оркестратора; completed — swarm_finished; неизвестный — not_found', async () => {
    const { core, stops } = setup();
    const created = await core.createSwarm(body(1));
    if (!created.ok) throw new Error('не создан');
    const id = created.value.id;
    core.ingestEvent(
      sys(id, 5, { type: 'swarm.started', source: 'orchestrator', agentId: null, data: {} }),
    );
    const stopped = await core.stopSwarm(id);
    expect(stopped.ok).toBe(true);
    expect(stops).toEqual([id]);

    const other = await core.createSwarm(body(1));
    if (!other.ok) throw new Error('не создан');
    core.ingestEvent(
      sys(other.value.id, 6, {
        type: 'swarm.completed',
        source: 'orchestrator',
        agentId: null,
        data: { result: 'R' },
      }),
    );
    const finished = await core.stopSwarm(other.value.id);
    expect(finished.ok === false && finished.error.code).toBe('swarm_finished');

    const unknown = await core.stopSwarm(uuid(12345));
    expect(unknown.ok === false && unknown.error.code).toBe('not_found');
  });

  it('AC-016-4: swarm.created и swarm.failed несут traceId порта, bus.message — текущий, событие из шины — свой', async () => {
    const { core, traceState } = setup();
    const created = await core.createSwarm(body(1));
    if (!created.ok) throw new Error('не создан');
    const id = created.value.id;

    const failing = setup({
      launch: async () => {
        throw new Error('connect ECONNREFUSED');
      },
    });
    const failed = await failing.core.createSwarm(body(1));
    if (!failed.ok) throw new Error('не создан');
    const failedEvents = failing.core.getEvents(failed.value.id, 0);
    expect(failedEvents.ok && failedEvents.value.map((e) => [e.type, e.traceId])).toEqual([
      ['swarm.created', T1],
      ['swarm.failed', T1],
    ]);

    traceState.current = T2;
    core.ingestMessage({
      id: uuid(8001),
      swarmId: id,
      from: 'user',
      to: 'agent-1',
      text: 'T',
      ts: '2026-10-22T10:00:02.000Z',
    });
    core.ingestEvent({
      ...sys(id, 1, { type: 'swarm.started', source: 'orchestrator', agentId: null, data: {} }),
      traceId: T3,
    });
    const events = core.getEvents(id, 0);
    expect(events.ok && events.value.map((e) => [e.type, e.traceId])).toEqual([
      ['swarm.created', T1],
      ['bus.message', T2],
      ['swarm.started', T3],
    ]);
  });

  it('AC-016-7: api-core пишет логи 4.8 — рой создан, оркестратор недоступен, отброшенные событие и сообщение', async () => {
    const ok = setup();
    const created = await ok.core.createSwarm(body(2));
    if (!created.ok) throw new Error('не создан');
    expect(ok.entries).toContainEqual({
      level: 'info',
      msg: 'swarm created',
      ctx: { swarmId: created.value.id, agents: 2 },
    });

    const error = new Error('connect ECONNREFUSED');
    const failing = setup({
      launch: async () => {
        throw error;
      },
    });
    const failed = await failing.core.createSwarm(body(1));
    if (!failed.ok) throw new Error('не создан');
    expect(failing.entries).toContainEqual({
      level: 'error',
      msg: 'orchestrator unavailable',
      ctx: { swarmId: failed.value.id, err: error },
    });

    ok.core.ingestEvent(
      sys(uuid(7777), 2, {
        type: 'swarm.started',
        source: 'orchestrator',
        agentId: null,
        data: {},
      }),
    );
    ok.core.ingestMessage({ id: 'не-uuid' });
    const dropped = ok.entries.filter((e) => e.level === 'warn');
    expect(dropped).toContainEqual({
      level: 'warn',
      msg: 'event dropped',
      ctx: expect.objectContaining({ swarmId: uuid(7777), reason: 'unknown_swarm' }),
    });
    expect(dropped).toContainEqual({
      level: 'warn',
      msg: 'message dropped',
      ctx: expect.objectContaining({ reason: 'invalid_schema' }),
    });
  });

  it('AC-002-26: llm.call от llm-gateway известного роя сохраняется с очередным seq, неизвестного роя — отбрасывается с unknown_swarm', async () => {
    const { core, entries } = setup();
    const created = await core.createSwarm(body(1));
    if (!created.ok) throw new Error('не создан');
    const id = created.value.id;
    const llmCall = {
      type: 'llm.call' as const,
      source: 'llm-gateway' as const,
      agentId: null,
      data: {
        callId: uuid(5001),
        model: 'chat-small',
        stream: false,
        status: 'ok' as const,
        usage: { promptTokens: 1000, cachedPromptTokens: 200, completionTokens: 500 },
        costMicroUsd: 9960,
        providerCostMicroUsd: null,
        latencyMs: 812,
      },
    };

    core.ingestEvent(sys(id, 20, llmCall));
    const events = core.getEvents(id, 0);
    expect(events.ok && events.value.map((e) => [e.type, e.source, e.seq])).toEqual([
      ['swarm.created', 'api', 1],
      ['llm.call', 'llm-gateway', 2],
    ]);

    core.ingestEvent(sys(uuid(7777), 21, llmCall));
    expect(entries).toContainEqual({
      level: 'warn',
      msg: 'event dropped',
      ctx: expect.objectContaining({
        swarmId: uuid(7777),
        type: 'llm.call',
        reason: 'unknown_swarm',
      }),
    });
    expect(core.getEvents(uuid(7777), 0).ok).toBe(false);
  });

  it('subscribe отдаёт хвост после after, затем новые события по возрастанию seq', async () => {
    const { core } = setup();
    const created = await core.createSwarm(body(1));
    if (!created.ok) throw new Error('не создан');
    const id = created.value.id;
    core.ingestEvent(
      sys(id, 10, { type: 'swarm.started', source: 'orchestrator', agentId: null, data: {} }),
    );
    const seen: number[] = [];
    const sub = core.subscribe(id, 0, (e) => seen.push(e.seq));
    expect(sub.ok).toBe(true);
    core.ingestEvent(
      sys(id, 11, {
        type: 'swarm.stopped',
        source: 'orchestrator',
        agentId: null,
        data: { reason: 'user' },
      }),
    );
    expect(seen).toEqual([1, 2, 3]);
    if (sub.ok) sub.value();
    core.ingestEvent(
      sys(id, 12, {
        type: 'swarm.failed',
        source: 'orchestrator',
        agentId: null,
        data: { reason: 'swarm_timeout' },
      }),
    );
    expect(seen).toEqual([1, 2, 3]);
  });
});
