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
import { FINAL_SWARM_STATUSES, type SwarmView } from '@swag/api-integration';

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

// Спека 003, 4.2. Адаптер асинхронный: reject — отказ хранилища или недопустимое событие.
export interface SwarmStore {
  appendEvent(event: PlatformEvent): Promise<void>; // seq назначен ядром; событие и проекция — атомарно; отказ на недопустимое событие — reject
  events(swarmId: string, afterSeq: number): Promise<PlatformEvent[]>; // по возрастанию seq
  view(swarmId: string): Promise<SwarmView | null>;
  views(): Promise<SwarmView[]>; // порядок не задан, сортирует ядро
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
  listSwarms(): Promise<SwarmSummary[]>;
  getSwarm(id: string): Promise<Result<SwarmView>>;
  getEvents(id: string, after: number): Promise<Result<PlatformEvent[]>>;
  stopSwarm(id: string): Promise<Result<void>>;
  ingestEvent(raw: unknown): Promise<void>; // из swarm.*.events
  ingestMessage(raw: unknown): Promise<void>; // из swarm.*.agent.*.inbox → bus.message
  subscribe(
    swarmId: string,
    after: number,
    listener: (e: PlatformEvent) => void,
  ): Promise<Result<() => void>>;
  closeInterrupted(): Promise<number>; // REQ-003-6; число закрытых роёв
}

// Подписчик роя: пока читается история, события копятся в buffer; потом уходят напрямую.
interface Subscriber {
  listener: (e: PlatformEvent) => void;
  reading: boolean;
  buffer: PlatformEvent[];
  last: number; // последний отданный seq
  closed: boolean;
}

const ok = <T>(value: T): Result<T> => ({ ok: true, value });
const fail = <T>(code: string, message: string, issues?: ApiError['issues']): Result<T> =>
  issues === undefined
    ? { ok: false, error: { code, message } }
    : { ok: false, error: { code, message, issues } };

export function createApiCore(deps: ApiCoreDeps): ApiCore {
  const { store, orchestrator, clock, ids, log, trace } = deps;
  const subscribers = new Map<string, Set<Subscriber>>();
  // Очередь записи (REQ-003-3): записи одного роя идут цепочкой, разных роёв — параллельно.
  const queues = new Map<string, Promise<unknown>>();
  // Лимит MAX_ACTIVE_SWARMS: рои, для которых createSwarm уже резервирует место до записи swarm.created.
  let reserving = 0;

  function deliver(swarmId: string, sub: Subscriber, event: PlatformEvent): void {
    if (sub.closed || event.seq <= sub.last) return;
    sub.last = event.seq;
    try {
      sub.listener(event);
    } catch (error) {
      log.warn('listener failed', { swarmId, err: error });
    }
  }

  // Единственная точка записи события роя: номер назначает ядро, рассылка — подписчикам.
  function commit(swarmId: string, input: PlatformEventInput): Promise<PlatformEvent | null> {
    const write = async (): Promise<PlatformEvent | null> => {
      let event: PlatformEvent;
      try {
        const seq = ((await store.view(swarmId))?.lastSeq ?? 0) + 1;
        event = { ...input, seq } as PlatformEvent;
        await store.appendEvent(event);
      } catch (error) {
        log.warn(input.type === 'bus.message' ? 'message dropped' : 'event dropped', {
          swarmId,
          type: input.type,
          reason: 'not_applicable',
          err: error,
        });
        return null;
      }
      // Рассылка вне try записи: сбой слушателя не должен попасть в «event dropped».
      for (const sub of subscribers.get(swarmId) ?? []) {
        if (sub.reading) sub.buffer.push(event);
        else deliver(swarmId, sub, event);
      }
      return event;
    };
    const written = (queues.get(swarmId) ?? Promise.resolve()).then(write);
    // Цепочка не копит отказы: write ловит всё внутри, это страховка.
    queues.set(
      swarmId,
      written.catch(() => undefined),
    );
    return written;
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
      const views = await store.views();
      const active = views.filter((v) => v.status === 'starting' || v.status === 'running').length;
      if (active + reserving >= deps.limits.maxActiveSwarms) {
        return fail(
          'too_many_active_swarms',
          `Активных роёв не больше ${deps.limits.maxActiveSwarms}`,
        );
      }
      reserving += 1;

      const swarmId = ids.uuid();
      const agents: AgentSpec[] = parsed.data.agents.map((draft, i) => ({
        ...draft,
        id: `agent-${i + 1}` as AgentId,
      }));
      const ts = clock.now();
      try {
        const created = await commit(swarmId, {
          id: ids.uuid(),
          swarmId,
          ts,
          source: 'api',
          agentId: null,
          traceId: trace.currentTraceId(),
          type: 'swarm.created',
          data: { task: parsed.data.task, agents },
        });
        if (created === null) throw new Error('swarm.created не записан');
      } finally {
        reserving -= 1;
      }
      log.info('swarm created', { swarmId, agents: agents.length });

      try {
        await orchestrator.launch({ swarmId, task: parsed.data.task, agents });
      } catch (error) {
        log.error('orchestrator unavailable', { swarmId, err: error });
        await commit(swarmId, {
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
      return ok((await store.view(swarmId)) as SwarmView);
    },

    async listSwarms() {
      return (await store.views())
        .map((v) => ({
          id: v.id,
          task: v.task,
          status: v.status,
          agentCount: v.agents.length,
          createdAt: v.createdAt,
        }))
        .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
    },

    async getSwarm(id) {
      const view = await store.view(id);
      return view ? ok(view) : fail('not_found', `Рой ${id} не найден`);
    },

    async getEvents(id, after) {
      if (!(await store.view(id))) return fail('not_found', `Рой ${id} не найден`);
      return ok(await store.events(id, after));
    },

    async stopSwarm(id) {
      const view = await store.view(id);
      if (!view) return fail('not_found', `Рой ${id} не найден`);
      if (FINAL_SWARM_STATUSES.includes(view.status)) {
        return fail('swarm_finished', `Рой уже ${view.status}`);
      }
      await orchestrator.stop(id);
      return ok(undefined);
    },

    async ingestEvent(raw) {
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
      if (!(await store.view(event.swarmId))) {
        log.warn('event dropped', {
          swarmId: event.swarmId,
          type: event.type,
          reason: 'unknown_swarm',
        });
        return;
      }
      await commit(event.swarmId, event);
    },

    async ingestMessage(raw) {
      const parsed = BusMessage.safeParse(raw);
      if (!parsed.success) {
        log.warn('message dropped', {
          reason: 'invalid_schema',
          issues: parsed.error.issues.length,
        });
        return;
      }
      const message = parsed.data;
      if (!(await store.view(message.swarmId))) {
        log.warn('message dropped', { swarmId: message.swarmId, reason: 'unknown_swarm' });
        return;
      }
      await commit(message.swarmId, {
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

    async subscribe(swarmId, after, listener) {
      if (!(await store.view(swarmId))) return fail('not_found', `Рой ${swarmId} не найден`);
      // Регистрация до чтения истории: события, записанные во время чтения, попадут в буфер (REQ-003-4).
      const sub: Subscriber = { listener, reading: true, buffer: [], last: after, closed: false };
      let set = subscribers.get(swarmId);
      if (!set) {
        set = new Set();
        subscribers.set(swarmId, set);
      }
      const registered = set;
      registered.add(sub);
      const unsubscribe = () => {
        sub.closed = true;
        registered.delete(sub);
      };
      try {
        for (const event of await store.events(swarmId, after)) deliver(swarmId, sub, event);
        sub.reading = false;
        for (const event of sub.buffer) deliver(swarmId, sub, event);
        sub.buffer = [];
      } catch (error) {
        unsubscribe();
        throw error;
      }
      return ok(unsubscribe);
    },

    async closeInterrupted() {
      let closed = 0;
      for (const view of await store.views()) {
        if (view.status !== 'starting' && view.status !== 'running') continue;
        const id = view.id;
        try {
          await orchestrator.stop(id);
        } catch (error) {
          log.warn('interrupted stop failed', { swarmId: id, err: error });
        }
        const event = await commit(id, {
          id: ids.uuid(),
          swarmId: id,
          ts: clock.now(),
          source: 'api',
          agentId: null,
          traceId: null,
          type: 'swarm.failed',
          data: { reason: 'api_restarted' },
        });
        if (event !== null) closed += 1;
      }
      log.info('interrupted swarms closed', { count: closed });
      return closed;
    },
  };
}
