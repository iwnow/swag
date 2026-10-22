import {
  BusMessage,
  PlatformEventInput,
  SwarmCreateRequest,
  type AgentId,
  type AgentSpec,
  type PlatformEvent,
  type ServiceInfo,
  type SwarmLaunch,
  type SwarmSummary,
} from '@swag/contracts';
import type { SwarmView } from '@swag/api-integration';

// Спека 001, 4.5.4. Порты объявляет ядро; адаптеры передаёт оболочка.

export interface Clock {
  now(): string; // ISO
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

export interface SwarmStore {
  appendEvent(event: PlatformEvent): void; // seq уже назначен ядром; бросает ошибку на недопустимое событие
  events(swarmId: string, afterSeq: number): PlatformEvent[];
  view(swarmId: string): SwarmView | null;
  views(): SwarmView[];
}

export interface OrchestratorClient {
  launch(launch: SwarmLaunch): Promise<void>; // ошибка = недоступен или не 202
  stop(swarmId: string): Promise<void>;
}

export interface ApiCoreDeps {
  version: string; // передаёт оболочка: ядро не читает package.json
  store: SwarmStore;
  orchestrator: OrchestratorClient;
  clock: Clock;
  ids: IdGenerator;
  log: Logger;
  trace: TraceContext;
  limits: { maxActiveSwarms: number };
}

export interface ApiError {
  code: string;
  message: string;
  issues?: { path: string; message: string }[];
}

export type Result<T> = { ok: true; value: T } | { ok: false; error: ApiError };

export interface ApiCore {
  info(): ServiceInfo;
  createSwarm(body: unknown): Promise<Result<SwarmView>>;
  listSwarms(): SwarmSummary[];
  getSwarm(id: string): Result<SwarmView>;
  getEvents(id: string, after: number): Result<PlatformEvent[]>;
  stopSwarm(id: string): Promise<Result<void>>;
  ingestEvent(raw: unknown): void; // из swarm.*.events
  ingestMessage(raw: unknown): void; // из swarm.*.agent.*.inbox → bus.message
  subscribe(
    swarmId: string,
    after: number,
    listener: (e: PlatformEvent) => void,
  ): Result<() => void>;
}

const FINISHED = new Set(['completed', 'stopped', 'failed']);

const ok = <T>(value: T): Result<T> => ({ ok: true, value });
const fail = <T>(code: string, message: string, issues?: ApiError['issues']): Result<T> =>
  issues === undefined
    ? { ok: false, error: { code, message } }
    : { ok: false, error: { code, message, issues } };

export function createApiCore(deps: ApiCoreDeps): ApiCore {
  const { store, orchestrator, clock, ids, log, trace } = deps;
  const listeners = new Map<string, Set<(e: PlatformEvent) => void>>();

  // Единственная точка записи события роя: номер назначает ядро, рассылка — подписчикам.
  function commit(swarmId: string, input: PlatformEventInput): PlatformEvent | null {
    const seq = (store.view(swarmId)?.lastSeq ?? 0) + 1;
    const event = { ...input, seq } as PlatformEvent;
    try {
      store.appendEvent(event);
    } catch (error) {
      log.warn(input.type === 'bus.message' ? 'message dropped' : 'event dropped', {
        swarmId,
        type: input.type,
        reason: 'not_applicable',
        err: error,
      });
      return null;
    }
    for (const listener of listeners.get(swarmId) ?? []) listener(event);
    return event;
  }

  return {
    info: () => ({ service: 'api', version: deps.version }),

    async createSwarm(body) {
      const parsed = SwarmCreateRequest.safeParse(body);
      if (!parsed.success) {
        return fail(
          'validation_error',
          'Запрос на рой не прошёл проверку',
          parsed.error.issues.map((issue) => ({
            path: issue.path.join('.'),
            message: issue.message,
          })),
        );
      }
      const views = store.views();
      const active = views.filter((v) => v.status === 'starting' || v.status === 'running').length;
      if (active >= deps.limits.maxActiveSwarms) {
        return fail(
          'too_many_active_swarms',
          `Активных роёв не больше ${deps.limits.maxActiveSwarms}`,
        );
      }

      const swarmId = ids.uuid();
      const agents: AgentSpec[] = parsed.data.agents.map((draft, i) => ({
        ...draft,
        id: `agent-${i + 1}` as AgentId,
      }));
      const ts = clock.now();
      commit(swarmId, {
        id: ids.uuid(),
        swarmId,
        ts,
        source: 'api',
        agentId: null,
        traceId: trace.currentTraceId(),
        type: 'swarm.created',
        data: { task: parsed.data.task, agents },
      });
      log.info('swarm created', { swarmId, agents: agents.length });

      try {
        await orchestrator.launch({ swarmId, task: parsed.data.task, agents });
      } catch (error) {
        log.error('orchestrator unavailable', { swarmId, err: error });
        commit(swarmId, {
          id: ids.uuid(),
          swarmId,
          ts: clock.now(),
          source: 'api',
          agentId: null,
          traceId: trace.currentTraceId(),
          type: 'swarm.failed',
          data: {
            reason: 'orchestrator_unavailable',
            detail: error instanceof Error ? error.message : String(error),
          },
        });
      }
      return ok(store.view(swarmId) as SwarmView);
    },

    listSwarms() {
      return store
        .views()
        .map((v) => ({
          id: v.id,
          task: v.task,
          status: v.status,
          agentCount: v.agents.length,
          createdAt: v.createdAt,
        }))
        .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
    },

    getSwarm(id) {
      const view = store.view(id);
      return view ? ok(view) : fail('not_found', `Рой ${id} не найден`);
    },

    getEvents(id, after) {
      if (!store.view(id)) return fail('not_found', `Рой ${id} не найден`);
      return ok(store.events(id, after));
    },

    async stopSwarm(id) {
      const view = store.view(id);
      if (!view) return fail('not_found', `Рой ${id} не найден`);
      if (FINISHED.has(view.status)) return fail('swarm_finished', `Рой уже ${view.status}`);
      await orchestrator.stop(id);
      return ok(undefined);
    },

    ingestEvent(raw) {
      const parsed = PlatformEventInput.safeParse(raw);
      if (!parsed.success) {
        log.warn('event dropped', { reason: 'invalid_schema', issues: parsed.error.issues.length });
        return;
      }
      // Событие из шины хранится с тем traceId, с которым его опубликовали (REQ-016-1).
      const event = parsed.data;
      if (event.type === 'swarm.created') {
        log.warn('event dropped', { swarmId: event.swarmId, reason: 'created_from_bus' });
        return;
      }
      if (!store.view(event.swarmId)) {
        log.warn('event dropped', {
          swarmId: event.swarmId,
          type: event.type,
          reason: 'unknown_swarm',
        });
        return;
      }
      commit(event.swarmId, event);
    },

    ingestMessage(raw) {
      const parsed = BusMessage.safeParse(raw);
      if (!parsed.success) {
        log.warn('message dropped', {
          reason: 'invalid_schema',
          issues: parsed.error.issues.length,
        });
        return;
      }
      const message = parsed.data;
      if (!store.view(message.swarmId)) {
        log.warn('message dropped', { swarmId: message.swarmId, reason: 'unknown_swarm' });
        return;
      }
      commit(message.swarmId, {
        id: ids.uuid(),
        swarmId: message.swarmId,
        ts: message.ts,
        source: 'api',
        agentId: message.from === 'user' ? null : message.from,
        traceId: trace.currentTraceId(),
        type: 'bus.message',
        data: { messageId: message.id, from: message.from, to: message.to, text: message.text },
      });
    },

    subscribe(swarmId, after, listener) {
      if (!store.view(swarmId)) return fail('not_found', `Рой ${swarmId} не найден`);
      // Синхронно: сначала догоняем хвост, затем регистрируемся — между ними событий не потеряется.
      for (const event of store.events(swarmId, after)) listener(event);
      let set = listeners.get(swarmId);
      if (!set) {
        set = new Set();
        listeners.set(swarmId, set);
      }
      set.add(listener);
      const registered = set;
      return ok(() => {
        registered.delete(listener);
      });
    },
  };
}
