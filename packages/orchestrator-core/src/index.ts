import {
  BusMessage,
  PlatformEventInput,
  SwarmLaunch,
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
export interface Logger {
  warn(message: string, context?: Record<string, unknown>): void;
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
  agent: { template: string; stepDelayMs: number }; // как песочница попадает в сеть и к NATS — дело адаптера
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
  handleEvent(raw: unknown): Promise<void>; // реагирует на agent.started и agent.result
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
      data: { reason: 'agent_start_timeout' | 'swarm_timeout' | 'sandbox_error'; detail?: string };
    };

const ok = (): Result<void> => ({ ok: true, value: undefined });
const fail = (code: string, message: string, issues?: OrchestratorError['issues']): Result<void> =>
  issues === undefined
    ? { ok: false, error: { code, message } }
    : { ok: false, error: { code, message, issues } };

export function createOrchestratorCore(deps: OrchestratorCoreDeps): OrchestratorCore {
  const { sandboxes, bus, clock, timers, ids, log } = deps;
  const runs = new Map<string, Run>();

  const envelope = (swarmId: string, agentId: AgentId | null) => ({
    id: ids.uuid(),
    swarmId,
    ts: clock.now(),
    source: 'orchestrator' as const,
    agentId,
  });

  async function publish(event: PlatformEventInput): Promise<void> {
    await bus.publishEvent(event);
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
        log.warn('не удалось удалить песочницу', {
          swarmId,
          agentId,
          sandboxId,
          reason: String(error),
        });
      }
    }
    for (const agent of run.launch.agents) {
      await publish({ ...envelope(swarmId, agent.id), type: 'agent.stopped', data: {} });
    }
    if (outcome.type === 'swarm.completed') {
      await publish({ ...envelope(swarmId, null), type: 'swarm.completed', data: outcome.data });
    } else if (outcome.type === 'swarm.stopped') {
      await publish({ ...envelope(swarmId, null), type: 'swarm.stopped', data: outcome.data });
    } else {
      await publish({ ...envelope(swarmId, null), type: 'swarm.failed', data: outcome.data });
    }
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

  function agentSpec(run: Run, index: number, agent: AgentSpec): SandboxSpec {
    const next = run.launch.agents[index + 1];
    return {
      template: deps.agent.template,
      env: {
        SWARM_ID: run.launch.swarmId,
        AGENT_ID: agent.id,
        AGENT_NAME: agent.name,
        AGENT_ROLE: agent.role,
        AGENT_NEXT: next?.id ?? '',
        AGENT_STEP_DELAY_MS: String(deps.agent.stepDelayMs),
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
      run.timers.push(
        timers.setTimeout(
          () => void finish(run, { type: 'swarm.failed', data: { reason: 'swarm_timeout' } }),
          deps.timeouts.swarmMs,
        ),
      );
      run.timers.push(
        timers.setTimeout(() => {
          if (run.phase === 'creating' || run.phase === 'waiting') {
            void finish(run, { type: 'swarm.failed', data: { reason: 'agent_start_timeout' } });
          }
        }, deps.timeouts.agentStartMs),
      );

      for (const [index, agent] of launch.agents.entries()) {
        try {
          const { sandboxId } = await sandboxes.create(agentSpec(run, index, agent));
          if (run.phase === 'finished') {
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
        log.warn('событие шины не прошло проверку схемы');
        return;
      }
      const event = parsed.data;
      const run = runs.get(event.swarmId);
      if (!run || run.phase === 'finished' || event.agentId === null) return;

      if (event.type === 'agent.started') {
        run.started.add(event.agentId);
        await checkReady(run);
      } else if (event.type === 'agent.result') {
        const last = run.launch.agents[run.launch.agents.length - 1];
        if (run.phase === 'running' && last && event.agentId === last.id) {
          await finish(run, { type: 'swarm.completed', data: { result: event.data.text } });
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
