import {
  BusMessage,
  ENTRY_AGENT_ID,
  PlatformEventInput,
  SwarmLaunch,
  type LlmSwarmRegistration,
  type AgentId,
  type AgentSpec,
  type ServiceInfo,
} from '@swag/contracts';

// Спека 001, 4.6.2 и 4.6.3. Порты объявляет ядро; адаптеры передаёт оболочка.

export type TimerId = unknown;

export interface Clock {
  now(): string;
}
export interface IdGenerator {
  uuid(): string;
}
// Спека 016, 4.3. Контекст лога — только id, числа и перечисления (REQ-016-10); err адаптер превращает в LogError.
export type LogContext = {
  swarmId?: string;
  agentId?: string;
  err?: unknown;
  [key: string]: unknown;
};
export interface Logger {
  debug(msg: string, ctx?: LogContext): void;
  info(msg: string, ctx?: LogContext): void;
  warn(msg: string, ctx?: LogContext): void;
  error(msg: string, ctx?: LogContext): void;
}

/** Текущий контекст трассировки. Ядро кладёт значение в конверт события, не разбирая его. */
export interface TraceContext {
  currentTraceId(): string | null; // null — вне трейса
}
export interface Timers {
  setTimeout(fn: () => void, ms: number): TimerId;
  clearTimeout(id: TimerId): void;
}

export interface SandboxSpec {
  template: string; // окружение агента в терминах провайдера: тег образа Docker, rootfs microVM, шаблон E2B
  env: Record<string, string>; // 4.7.1 без NATS_URL — его добавляет адаптер
  metadata: Record<string, string>; // ключ-значение для поиска песочниц роя и сирот
}

export interface SandboxProvider {
  create(spec: SandboxSpec): Promise<{ sandboxId: string }>; // создаёт и запускает
  remove(sandboxId: string): Promise<void>; // остановить и удалить; нет такой — не ошибка
  list(match: Record<string, string | true>): Promise<string[]>; // id песочниц; true — ключ есть с любым значением
}

// Спека 004, 4.6: регистрация роя в gateway. register — исключение при отказе; close — после уборки песочниц.
export interface LlmSwarms {
  register(reg: LlmSwarmRegistration): Promise<void>;
  close(swarmId: string): Promise<void>;
}

export interface OrchestratorBus {
  publishEvent(event: PlatformEventInput): Promise<void>;
  publishMessage(message: BusMessage): Promise<void>;
  // подписку на swarm.*.events оболочка делает сама и передаёт события в core.handleEvent
}

export interface OrchestratorCoreDeps {
  version: string; // передаёт оболочка: ядро не читает package.json
  sandboxes: SandboxProvider;
  bus: OrchestratorBus;
  clock: Clock;
  timers: Timers;
  ids: IdGenerator;
  log: Logger;
  trace: TraceContext;
  llmSwarms: LlmSwarms;
  // Значения env 4.8, которые ставит ядро. NATS_URL, OTEL_EXPORTER_OTLP_ENDPOINT, LLM_GATEWAY_URL — дело адаптера.
  agent: {
    template: string;
    maxSteps: number;
    maxTokens: number;
    llmGatewayToken: string;
    flushTimeoutMs: number;
  };
  timeouts: { agentStartMs: number; swarmMs: number };
}

export interface OrchestratorError {
  code: string;
  message: string;
  issues?: { path: string; message: string }[];
}

export type Result<T> = { ok: true; value: T } | { ok: false; error: OrchestratorError };

export interface OrchestratorCore {
  info(): ServiceInfo;
  launch(body: unknown): Promise<Result<void>>;
  stop(swarmId: string): Promise<Result<void>>;
  handleEvent(raw: unknown): Promise<void>; // реагирует на agent.started, agent.result и agent.failed
  cleanupOrphans(): Promise<number>; // число удалённых песочниц
}

type Phase = 'creating' | 'waiting' | 'running' | 'finished';

interface Run {
  launch: SwarmLaunch;
  phase: Phase;
  sandboxes: Map<AgentId, string>; // agentId → sandboxId
  started: Set<AgentId>;
  timers: TimerId[];
}

type Outcome =
  | { type: 'swarm.completed'; data: { result: string } }
  | { type: 'swarm.stopped'; data: { reason: 'user' } }
  | {
      type: 'swarm.failed';
      data: {
        reason:
          | 'agent_start_timeout'
          | 'swarm_timeout'
          | 'sandbox_error'
          | 'agent_failed'
          | 'budget_exceeded'
          | 'gateway_unavailable';
        detail?: string;
      };
    };

const FINISHED_STATUS: Record<Outcome['type'], 'completed' | 'stopped' | 'failed'> = {
  'swarm.completed': 'completed',
  'swarm.stopped': 'stopped',
  'swarm.failed': 'failed',
};

const ok = (): Result<void> => ({ ok: true, value: undefined });
const fail = (code: string, message: string, issues?: OrchestratorError['issues']): Result<void> =>
  issues === undefined
    ? { ok: false, error: { code, message } }
    : { ok: false, error: { code, message, issues } };

export function createOrchestratorCore(deps: OrchestratorCoreDeps): OrchestratorCore {
  const { sandboxes, bus, clock, timers, ids, log, trace, llmSwarms } = deps;
  const runs = new Map<string, Run>();

  // traceId — из порта: таймеры и обработчики событий выполняются в контексте запуска роя (REQ-016-2).
  const envelope = (swarmId: string, agentId: AgentId | null) => ({
    id: ids.uuid(),
    swarmId,
    ts: clock.now(),
    source: 'orchestrator' as const,
    agentId,
    traceId: trace.currentTraceId(),
  });

  async function publish(event: PlatformEventInput): Promise<void> {
    await bus.publishEvent(event);
  }

  // stop меняет фазу во время await; TS после проверки выше сузил бы run.phase и счёл бы сравнение с 'finished' ошибкой.
  const isFinished = (run: Run): boolean => run.phase === 'finished';

  // Закрытие роя в gateway (4.6): сбой логируется и не мешает завершению роя.
  async function closeInGateway(swarmId: string): Promise<void> {
    try {
      await llmSwarms.close(swarmId);
    } catch (error) {
      log.warn('gateway_close_failed', { swarmId, err: error });
    }
  }

  // Уборка роя и итоговые события (4.6.2): песочницы → agent.stopped → событие роя.
  async function finish(run: Run, outcome: Outcome): Promise<void> {
    if (run.phase === 'finished') return;
    run.phase = 'finished';
    for (const id of run.timers) timers.clearTimeout(id);
    const swarmId = run.launch.swarmId;

    for (const [agentId, sandboxId] of run.sandboxes) {
      try {
        await sandboxes.remove(sandboxId);
      } catch (error) {
        log.warn('sandbox remove failed', { swarmId, agentId, err: error });
      }
    }
    for (const agent of run.launch.agents) {
      await publish({ ...envelope(swarmId, agent.id), type: 'agent.stopped', data: {} });
    }
    await closeInGateway(swarmId);
    if (outcome.type === 'swarm.completed') {
      await publish({ ...envelope(swarmId, null), type: 'swarm.completed', data: outcome.data });
    } else if (outcome.type === 'swarm.stopped') {
      await publish({ ...envelope(swarmId, null), type: 'swarm.stopped', data: outcome.data });
    } else {
      await publish({ ...envelope(swarmId, null), type: 'swarm.failed', data: outcome.data });
    }
    log.info('swarm finished', { swarmId, status: FINISHED_STATUS[outcome.type] });
  }

  // Когда все агенты стартовали — задача первому агенту и swarm.started (4.6.2, шаги 4–5).
  async function checkReady(run: Run): Promise<void> {
    if (run.phase !== 'waiting' || run.started.size < run.launch.agents.length) return;
    run.phase = 'running'; // до первого await, чтобы параллельные agent.started не запустили задачу дважды
    const swarmId = run.launch.swarmId;
    const first = run.launch.agents[0];
    if (!first) return;
    await bus.publishMessage({
      id: ids.uuid(),
      swarmId,
      from: 'user',
      to: first.id,
      text: run.launch.task,
      ts: clock.now(),
    });
    await publish({ ...envelope(swarmId, null), type: 'swarm.started', data: {} });
  }

  // env 4.8 без адаптерных ключей. TRACEPARENT здесь нет: порт TraceContext отдаёт только traceId (см. README).
  function agentSpec(run: Run, agent: AgentSpec): SandboxSpec {
    const peers = run.launch.agents
      .filter((other) => other.id !== agent.id)
      .map((other) => ({ id: other.id, name: other.name, role: other.role }));
    return {
      template: deps.agent.template,
      env: {
        SWARM_ID: run.launch.swarmId,
        AGENT_ID: agent.id,
        AGENT_NAME: agent.name,
        AGENT_ROLE: agent.role,
        AGENT_MODEL: agent.model,
        AGENT_PEERS: JSON.stringify(peers),
        AGENT_ENTRY: ENTRY_AGENT_ID,
        AGENT_MAX_STEPS: String(deps.agent.maxSteps),
        AGENT_MAX_TOKENS: String(agent.maxTokens ?? run.launch.maxTokens ?? deps.agent.maxTokens), // 031, 4.4
        LLM_GATEWAY_TOKEN: deps.agent.llmGatewayToken,
        TELEMETRY_FLUSH_TIMEOUT_MS: String(deps.agent.flushTimeoutMs),
      },
      metadata: {
        'swag.kind': 'agent',
        'swag.swarm': run.launch.swarmId,
        'swag.agent': agent.id,
      },
    };
  }

  return {
    info: () => ({ service: 'orchestrator', version: deps.version }),

    async launch(body) {
      const parsed = SwarmLaunch.safeParse(body);
      if (!parsed.success) {
        return fail(
          'validation_error',
          'Запуск роя не прошёл проверку',
          parsed.error.issues.map((issue) => ({
            path: issue.path.join('.'),
            message: issue.message,
          })),
        );
      }
      const launch = parsed.data;
      if (runs.has(launch.swarmId))
        return fail('swarm_exists', `Рой ${launch.swarmId} уже запущен`);

      const run: Run = {
        launch,
        phase: 'creating',
        sandboxes: new Map(),
        started: new Set(),
        timers: [],
      };
      runs.set(launch.swarmId, run);
      log.info('swarm launch', { swarmId: launch.swarmId, agents: launch.agents.length });
      try {
        await llmSwarms.register({
          swarmId: launch.swarmId,
          budgetMicroUsd: launch.budgetMicroUsd,
          expiresAt:
            deps.timeouts.swarmMs === 0
              ? null
              : new Date(Date.parse(clock.now()) + deps.timeouts.swarmMs + 60000).toISOString(),
          agents: launch.agents.map((agent) => ({
            agentId: agent.id,
            model: agent.model,
            budgetMicroUsd: agent.budgetMicroUsd,
          })),
        });
      } catch (error) {
        await finish(run, {
          type: 'swarm.failed',
          data: {
            reason: 'gateway_unavailable',
            detail: error instanceof Error ? error.message : String(error),
          },
        });
        return ok();
      }
      if (run.phase === 'finished') {
        // stop пришёл во время регистрации: finish уже закрыл рой, а регистрация могла пройти после закрытия
        await closeInGateway(launch.swarmId);
        return ok();
      }
      run.timers.push(
        timers.setTimeout(() => {
          if (run.phase === 'finished') return;
          log.error('swarm timeout', { swarmId: launch.swarmId });
          void finish(run, { type: 'swarm.failed', data: { reason: 'swarm_timeout' } });
        }, deps.timeouts.swarmMs),
      );
      run.timers.push(
        timers.setTimeout(() => {
          if (run.phase === 'creating' || run.phase === 'waiting') {
            const missing = launch.agents.map((a) => a.id).filter((id) => !run.started.has(id));
            log.error('agent start timeout', { swarmId: launch.swarmId, missing });
            void finish(run, { type: 'swarm.failed', data: { reason: 'agent_start_timeout' } });
          }
        }, deps.timeouts.agentStartMs),
      );

      for (const agent of launch.agents) {
        try {
          const { sandboxId } = await sandboxes.create(agentSpec(run, agent));
          if (isFinished(run)) {
            // рой остановили во время создания — эту песочницу удаляем сразу
            await sandboxes.remove(sandboxId);
            break;
          }
          run.sandboxes.set(agent.id, sandboxId);
          await publish({
            ...envelope(launch.swarmId, agent.id),
            type: 'agent.launched',
            data: { sandboxId },
          });
        } catch (error) {
          log.error('sandbox create failed', {
            swarmId: launch.swarmId,
            agentId: agent.id,
            err: error,
          });
          await finish(run, {
            type: 'swarm.failed',
            data: {
              reason: 'sandbox_error',
              detail: error instanceof Error ? error.message : String(error),
            },
          });
          return ok();
        }
      }
      if (run.phase === 'creating') run.phase = 'waiting';
      await checkReady(run);
      return ok();
    },

    async stop(swarmId) {
      const run = runs.get(swarmId);
      if (!run) return fail('not_found', `Рой ${swarmId} не найден`);
      await finish(run, { type: 'swarm.stopped', data: { reason: 'user' } });
      return ok();
    },

    async handleEvent(raw) {
      const parsed = PlatformEventInput.safeParse(raw);
      if (!parsed.success) {
        log.warn('event dropped', { reason: 'invalid_schema', issues: parsed.error.issues.length });
        return;
      }
      const event = parsed.data;
      const run = runs.get(event.swarmId);
      if (!run || run.phase === 'finished' || event.agentId === null) return;

      if (event.type === 'agent.started') {
        run.started.add(event.agentId);
        await checkReady(run);
      } else if (event.type === 'agent.result') {
        // 4.9: итог роя — только ответ агента-входа; ответы остальных агентов игнорируются
        if (run.phase === 'running' && event.agentId === ENTRY_AGENT_ID) {
          await finish(run, { type: 'swarm.completed', data: { result: event.data.text } });
        }
      } else if (event.type === 'agent.failed' && run.phase === 'running') {
        // 4.6: отказ по бюджету из gateway приходит как model_error:<код> (022, 4.3)
        const reason = event.data.reason;
        if (
          reason === 'model_error:swarm_budget_exceeded' ||
          reason === 'model_error:agent_budget_exceeded'
        ) {
          await finish(run, {
            type: 'swarm.failed',
            data: {
              reason: 'budget_exceeded',
              detail: `${event.agentId}: ${reason.slice('model_error:'.length)}`,
            },
          });
        } else {
          await finish(run, {
            type: 'swarm.failed',
            data: { reason: 'agent_failed', detail: `${event.agentId}: ${reason}` },
          });
        }
      }
    },

    async cleanupOrphans() {
      const ids = await sandboxes.list({ 'swag.kind': true });
      for (const id of ids) await sandboxes.remove(id);
      return ids.length;
    },
  };
}
