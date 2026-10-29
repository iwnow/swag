import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createApiCore,
  type Logger,
  type OrchestratorClient,
  type TraceContext,
} from '@swag/api-core';
import {
  createAgentCore,
  type AgentBus,
  type AgentConfigCore,
  type ChatModel,
  type ChatModelResult,
} from '@swag/agent-core';
import {
  createOrchestratorCore,
  type OrchestratorBus,
  type SandboxProvider,
  type SandboxSpec,
} from '@swag/orchestrator-core';
import { createMemorySwarmStore } from '@swag/adapter-memory';
import { createMemoryExporters, startTelemetry, type Telemetry } from '@swag/adapter-telemetry';
import { AgentConfig, loadConfig } from '@swag/config';
import {
  ALL_EVENTS,
  ALL_INBOXES,
  eventsSubject,
  inboxSubject,
  type ModelId,
  type PlatformEventInput,
} from '@swag/contracts';

// Сквозной тест без Docker и сети (AC-022-21): api-core, orchestrator-core и три agent-core
// в одном процессе; шина — в памяти; песочница — фейк, который поднимает agent-core из env,
// собранного ядром оркестратора (тем же разбором, что в apps/agent); модель — скриптовая на агента.

type Handler = (raw: unknown) => void;

// Минимальная шина в памяти с wildcard-подписками NATS ('*' — один токен).
// Доставка через setTimeout: асинхронный контекст публикующего (AsyncLocalStorage) сохраняется.
function createHub() {
  const subs: { pattern: string[]; handler: Handler }[] = [];
  const matches = (pattern: string[], subject: string[]) =>
    pattern.length === subject.length && pattern.every((p, i) => p === '*' || p === subject[i]);
  return {
    subscribe(pattern: string, handler: Handler): () => void {
      const entry = { pattern: pattern.split('.'), handler };
      subs.push(entry);
      return () => {
        const index = subs.indexOf(entry);
        if (index >= 0) subs.splice(index, 1);
      };
    },
    publish(subject: string, value: unknown): void {
      const tokens = subject.split('.');
      for (const sub of [...subs]) {
        if (matches(sub.pattern, tokens)) setTimeout(() => sub.handler(value), 0);
      }
    },
  };
}

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

const toolCall = (name: string, args: Record<string, unknown>): ChatModelResult => ({
  ok: true,
  message: {
    content: null,
    tool_calls: [
      { id: `call_${name}`, type: 'function', function: { name, arguments: JSON.stringify(args) } },
    ],
  },
});

// Скриптовый ChatModel: ответы по порядку. Исчерпанный сценарий — ok: false, агент уходит в failed, и тест это увидит.
function scripted(replies: ChatModelResult[]): ChatModel {
  return {
    complete: async () =>
      replies.shift() ?? {
        ok: false,
        error: { code: 'invalid_response', message: 'сценарий исчерпан' },
      },
  };
}

// Сценарий AC-022-21: agent-1 → agent-2 → agent-3 → agent-1; agent-1 завершает задачу finish после ответа agent-3.
// Сценарий создаётся заново на каждую песочницу, поэтому очередь ответов не делится между роями.
function team(agentId: string): ChatModelResult[] {
  switch (agentId) {
    case 'agent-1':
      return [
        toolCall('send_message', { to: 'agent-2', text: 'Подготовь часть' }),
        toolCall('finish', { result: 'Итог: задача решена' }),
      ];
    case 'agent-2':
      return [toolCall('send_message', { to: 'agent-3', text: 'Дополни' })];
    case 'agent-3':
      return [toolCall('send_message', { to: 'agent-1', text: 'Дополнено' })];
    default:
      return [];
  }
}

// Агент без участников не отвечает: одиночный рой из AC-016-12 ждёт остановки, а не завершения.
const modelFor = (config: AgentConfigCore): ChatModel =>
  config.peers.length === 0
    ? { complete: () => new Promise<ChatModelResult>(() => undefined) }
    : scripted(team(config.agentId));

const threeAgents = (role: (n: number) => string) =>
  ['A', 'B', 'C'].map((name, i) => ({ name, role: role(i + 1) }));

// Весь рой в одном процессе: api-core, orchestrator-core, agent-core на каждую «песочницу».
function world(log: Logger, trace: TraceContext) {
  const hub = createHub();
  let counter = 0;
  const ids = { uuid: () => uuid(++counter) };
  const clock = { now: () => '2026-10-22T10:00:00.000Z' };

  // песочница: на create поднимает agent-core в процессе, на remove — отписывает
  const running = new Map<string, () => void>();
  const sandboxes = new Map<string, SandboxSpec>();
  const sandboxProvider: SandboxProvider = {
    create: async (spec) => {
      const sandboxId = `sb-${++counter}`;
      sandboxes.set(sandboxId, spec);
      // Адаптерные ключи (шина и gateway) — фейковые; остальное разбирается как в apps/agent.
      const env = loadConfig(AgentConfig, {
        ...spec.env,
        NATS_URL: 'nats://fake:4222',
        LLM_GATEWAY_URL: 'http://fake-gateway/v1',
      });
      const agentBus: AgentBus = {
        subscribe: async (subject, handler) => {
          running.set(sandboxId, hub.subscribe(subject, handler));
        },
        publishEvent: async (event) => hub.publish(eventsSubject(event.swarmId), event),
        publishMessage: async (message) =>
          hub.publish(inboxSubject(message.swarmId, message.to), message),
      };
      const config: AgentConfigCore = {
        swarmId: env.SWARM_ID,
        agentId: env.AGENT_ID,
        agentName: env.AGENT_NAME,
        agentRole: env.AGENT_ROLE,
        model: env.AGENT_MODEL as ModelId,
        peers: env.AGENT_PEERS,
        entryAgentId: env.AGENT_ENTRY,
        maxSteps: env.AGENT_MAX_STEPS,
        maxTokens: env.AGENT_MAX_TOKENS,
      };
      const agent = createAgentCore({
        version: 'test',
        bus: agentBus,
        clock,
        ids,
        log,
        trace,
        model: modelFor(config),
        config,
      });
      await agent.start();
      return { sandboxId };
    },
    remove: async (sandboxId) => {
      running.get(sandboxId)?.();
      running.delete(sandboxId);
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

  const orchestratorBus: OrchestratorBus = {
    publishEvent: async (event: PlatformEventInput) =>
      hub.publish(eventsSubject(event.swarmId), event),
    publishMessage: async (message) =>
      hub.publish(inboxSubject(message.swarmId, message.to), message),
  };
  const orchestrator = createOrchestratorCore({
    version: 'test',
    sandboxes: sandboxProvider,
    bus: orchestratorBus,
    clock,
    timers: {
      setTimeout: (fn, ms) => setTimeout(fn, ms),
      clearTimeout: (id) => clearTimeout(id as ReturnType<typeof setTimeout>),
    },
    ids,
    log,
    trace,
    agent: {
      template: 'swag-agent:test',
      maxSteps: 20,
      maxTokens: 2048,
      llmGatewayToken: 'fake-gateway-token-0123456789abcdef',
      flushTimeoutMs: 500,
    },
    timeouts: { agentStartMs: 5000, swarmMs: 60000 },
  });
  hub.subscribe(ALL_EVENTS, (raw) => void orchestrator.handleEvent(raw));

  const orchestratorClient: OrchestratorClient = {
    launch: async (launch) => {
      const result = await orchestrator.launch(launch);
      if (!result.ok) throw new Error(result.error.message);
    },
    stop: async (swarmId) => {
      const result = await orchestrator.stop(swarmId);
      if (!result.ok) throw new Error(result.error.message);
    },
  };
  const api = createApiCore({
    version: 'test',
    store: createMemorySwarmStore(),
    orchestrator: orchestratorClient,
    clock,
    ids,
    log,
    trace,
    limits: { maxActiveSwarms: 3 },
  });
  hub.subscribe(ALL_EVENTS, (raw) => api.ingestEvent(raw));
  hub.subscribe(ALL_INBOXES, (raw) => api.ingestMessage(raw));
  return { api, sandboxes };
}

describe('сквозной скелет без Docker', () => {
  it('AC-022-21, AC-001-20: createSwarm с тремя агентами — completed по сообщениям, result из finish, песочниц нет, seq без пропусков', async () => {
    const logs: string[] = [];
    const nothing = () => undefined;
    const log = {
      debug: nothing,
      info: nothing,
      warn: (message: string) => logs.push(message),
      error: (message: string) => logs.push(message),
    };
    const { api, sandboxes } = world(log, { currentTraceId: () => null });

    const created = await api.createSwarm({
      task: 'T',
      agents: threeAgents((n) => `r${n}`),
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const id = created.value.id;

    await vi.waitFor(
      () => expect(api.getSwarm(id)).toMatchObject({ ok: true, value: { status: 'completed' } }),
      {
        timeout: 5000,
      },
    );

    const view = api.getSwarm(id);
    if (!view.ok) throw new Error('рой не найден');
    expect(view.value.result).toBe('Итог: задача решена');
    expect(view.value.agents.every((a) => a.status === 'stopped' || a.status === 'done')).toBe(
      true,
    );
    expect(view.value.edges).toEqual([
      { from: 'agent-1', to: 'agent-2', messages: 1 },
      { from: 'agent-2', to: 'agent-3', messages: 1 },
      { from: 'agent-3', to: 'agent-1', messages: 1 },
    ]);
    expect(sandboxes.size).toBe(0);
    const events = api.getEvents(id, 0);
    if (!events.ok) throw new Error('нет событий');
    expect(events.value.map((e) => e.seq)).toEqual(events.value.map((_, i) => i + 1));
    expect(logs).toEqual([]);
  });
});

// Спека 016: тот же сквозной сценарий с настоящим TraceContext из adapter-telemetry (без экспорта в OTLP).
const T = '4bf92f3577b34da6a3ce929d0e0e4736';
const S = '5ce0e9a56015fec5aadfa328ae398115';
const MARKER = 'SECRET-MARKER-016';
const parent = (traceId: string) => `00-${traceId}-00f067aa0ba902b7-01`;

describe('сквозной скелет с трассировкой', () => {
  let telemetry: Telemetry | null = null;
  afterEach(async () => {
    await telemetry?.shutdown();
    telemetry = null;
  });

  function traced() {
    const lines: string[] = [];
    const memory = createMemoryExporters();
    telemetry = startTelemetry({
      service: 'api',
      version: 'test',
      otlpEndpoint: null,
      logLevel: 'debug', // все уровни: проверка утечки текста по всем записям
      flushTimeoutMs: 500,
      stdout: (line) => lines.push(line),
      exporters: { spans: memory.spans },
    });
    return { telemetry, lines, memory, ...world(telemetry.logger, telemetry.trace) };
  }

  it('AC-016-12: все события роя несут traceId запроса T, ни одного null; события остановки второго роя — S', async () => {
    const { telemetry: tel, api } = traced();

    const first = await tel.inSpan('POST /swarms', { parent: parent(T) }, () =>
      api.createSwarm({ task: 'T', agents: threeAgents((n) => `r${n}`) }),
    );
    if (!first.ok) throw new Error('не создан');
    await vi.waitFor(
      () => expect(api.getSwarm(first.value.id)).toMatchObject({ value: { status: 'completed' } }),
      { timeout: 5000 },
    );
    const events = api.getEvents(first.value.id, 0);
    if (!events.ok) throw new Error('нет событий');
    expect(events.value.length).toBeGreaterThan(10);
    expect(events.value.filter((e) => e.traceId !== T)).toEqual([]);

    const second = await tel.inSpan('POST /swarms', { parent: null }, () =>
      api.createSwarm({ task: 'T2', agents: [{ name: 'A', role: 'r1' }] }),
    );
    if (!second.ok) throw new Error('не создан');
    const stopped = await tel.inSpan('POST /swarms/:id/stop', { parent: parent(S) }, () =>
      api.stopSwarm(second.value.id),
    );
    expect(stopped.ok).toBe(true);
    await vi.waitFor(() =>
      expect(api.getSwarm(second.value.id)).toMatchObject({ value: { status: 'stopped' } }),
    );
    const secondEvents = api.getEvents(second.value.id, 0);
    if (!secondEvents.ok) throw new Error('нет событий');
    const stopEvents = secondEvents.value.filter(
      (e) => e.type === 'agent.stopped' || e.type === 'swarm.stopped',
    );
    expect(stopEvents.map((e) => e.type)).toEqual(['agent.stopped', 'swarm.stopped']);
    for (const event of stopEvents) expect(event.traceId).toBe(S);
  });

  it('AC-016-13: задача и роли с маркером — маркера нет ни в одной строке лога и ни в одном атрибуте спана', async () => {
    const { telemetry: tel, api, lines, memory } = traced();
    const created = await tel.inSpan('POST /swarms', { parent: parent(T) }, () =>
      api.createSwarm({
        task: `Задача ${MARKER}`,
        agents: threeAgents((n) => `роль ${MARKER} ${n}`),
      }),
    );
    if (!created.ok) throw new Error('не создан');
    await vi.waitFor(
      () =>
        expect(api.getSwarm(created.value.id)).toMatchObject({ value: { status: 'completed' } }),
      { timeout: 5000 },
    );
    // Маркер есть в событиях (их видит владелец роя), но не в телеметрии.
    expect(JSON.stringify(api.getEvents(created.value.id, 0))).toContain(MARKER);
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) expect(line).not.toContain(MARKER);
    expect(memory.finishedSpans.length).toBeGreaterThan(0);
    for (const span of memory.finishedSpans) {
      expect(JSON.stringify(span.attributes)).not.toContain(MARKER);
      expect(JSON.stringify(span.events)).not.toContain(MARKER);
    }
  });
});
