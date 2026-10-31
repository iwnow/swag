import {
  BusMessage,
  PlatformEventInput,
  SwarmCreateRequest,
  can,
  type Actor,
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

// Спека 013, 4.4. Резерв бюджета роя из баланса организации; сбой хранилища баланса — исключение.
export interface Billing {
  reserve(orgId: string, swarmId: string, amountMicroUsd: number): Promise<'ok' | 'insufficient'>;
  settle(swarmId: string, spentMicroUsd: number): Promise<void>;
  holds(): Promise<{ swarmId: string; orgId: string; amountMicroUsd: number }[]>;
}

export interface ApiCoreDeps {
  version: string; // передаёт оболочка: ядро не читает package.json
  store: SwarmStore;
  orchestrator: OrchestratorClient;
  billing: Billing;
  clock: Clock;
  ids: IdGenerator;
  log: Logger;
  trace: TraceContext;
  limits: { maxActiveSwarms: number; maxBudgetMicroUsd: number; maxTokens: number }; // maxBudgetMicroUsd — SWARM_MAX_BUDGET_MICRO_USD (004, 4.7); maxTokens — AGENT_MAX_TOKENS_LIMIT (031, 4.2)
}

export interface ApiError {
  code: string;
  message: string;
  issues?: { path: string; message: string }[];
}

export type Result<T> = { ok: true; value: T } | { ok: false; error: ApiError };

export interface ApiCore {
  info(): ServiceInfo;
  createSwarm(actor: Actor, body: unknown): Promise<Result<SwarmView>>;
  listSwarms(actor: Actor): Promise<SwarmSummary[]>;
  getSwarm(actor: Actor, id: string): Promise<Result<SwarmView>>;
  getEvents(actor: Actor, id: string, after: number): Promise<Result<PlatformEvent[]>>;
  stopSwarm(actor: Actor, id: string): Promise<Result<void>>;
  subscribe(
    actor: Actor,
    swarmId: string,
    after: number,
    listener: (e: PlatformEvent) => void,
  ): Promise<Result<() => void>>;
  stopSwarmsOfUser(userId: string): Promise<number>; // активные рои с createdBy = userId; число остановленных
  ingestEvent(raw: unknown): Promise<void>; // из swarm.*.events
  ingestMessage(raw: unknown): Promise<void>; // из swarm.*.agent.*.inbox → bus.message
  closeInterrupted(): Promise<number>; // REQ-003-6; число закрытых роёв
  settlePending(): Promise<number>; // 013, REQ-013-8; число закрытых резервов
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

// Спека 024, 4.4, правило 1. Рой до 024 (orgId и createdBy = null) виден только супервизору.
function visible(actor: Actor, view: SwarmView): boolean {
  if (actor.role === 'supervisor') return true;
  const orgId = view.orgId ?? null;
  const createdBy = view.createdBy ?? null;
  if (actor.role === 'admin') return orgId !== null && orgId === actor.orgId;
  return createdBy !== null && createdBy === actor.userId;
}

// Спека 024, 4.4, правило 5: стоимость провайдера — только супервизору; хранилище не меняется.
function forActor(actor: Actor, event: PlatformEvent): PlatformEvent {
  if (actor.role === 'supervisor' || event.type !== 'llm.call') return event;
  return { ...event, data: { ...event.data, providerCostMicroUsd: null } };
}

// Спека 013, 4.4 и Q-8: сумма закрытия — из итогового события; нет поля — из проекции после события.
const FINAL_EVENT_TYPES: readonly string[] = ['swarm.completed', 'swarm.stopped', 'swarm.failed'];

// Проекция читается только когда поля нет: при числовом spentMicroUsd хранилище не трогается.
async function finalSpent(event: PlatformEvent, store: SwarmStore, log: Logger): Promise<number> {
  const spent = 'spentMicroUsd' in event.data ? event.data.spentMicroUsd : undefined;
  if (typeof spent === 'number') return spent;
  const view = await store.view(event.swarmId);
  if (view === null) throw new Error('проекция роя не найдена после записи');
  log.warn('balance_settled_from_events', {
    swarmId: event.swarmId,
    spentMicroUsd: view.spentMicroUsd,
  });
  return view.spentMicroUsd;
}

export function createApiCore(deps: ApiCoreDeps): ApiCore {
  const { store, orchestrator, billing, clock, ids, log, trace } = deps;
  const subscribers = new Map<string, Set<Subscriber>>();
  // Очередь записи (REQ-003-3): записи одного роя идут цепочкой, разных роёв — параллельно.
  const queues = new Map<string, Promise<unknown>>();
  // Лимит MAX_ACTIVE_SWARMS: рои, для которых createSwarm уже резервирует место до записи swarm.created.
  let reserving = 0;

  async function visibleView(actor: Actor, id: string): Promise<SwarmView | null> {
    const view = await store.view(id);
    return view && visible(actor, view) ? view : null;
  }

  function deliver(swarmId: string, sub: Subscriber, event: PlatformEvent): void {
    if (sub.closed || event.seq <= sub.last) return;
    sub.last = event.seq;
    try {
      sub.listener(event);
    } catch (error) {
      log.warn('listener failed', { swarmId, err: error });
    }
  }

  // Закрытие резерва на итоговом событии (013, 4.4). Сбой не отменяет запись события.
  async function settleFinal(swarmId: string, event: PlatformEvent): Promise<void> {
    try {
      await billing.settle(swarmId, await finalSpent(event, store, log));
    } catch (err) {
      log.error('billing_settle_failed', { swarmId, err });
    }
  }

  // Единственная точка записи события роя: номер назначает ядро, рассылка — подписчикам.
  function commit(swarmId: string, input: PlatformEventInput): Promise<PlatformEvent | null> {
    const write = async (): Promise<PlatformEvent | null> => {
      let event: PlatformEvent;
      let before: SwarmView | null;
      try {
        before = await store.view(swarmId);
        const seq = (before?.lastSeq ?? 0) + 1;
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
      // Повтор итогового события у уже финального роя резерв не закрывает второй раз (AC-013-12).
      const wasFinal = before !== null && FINAL_SWARM_STATUSES.includes(before.status);
      if (!wasFinal && FINAL_EVENT_TYPES.includes(event.type)) await settleFinal(swarmId, event);
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

    async createSwarm(actor, body) {
      if (!can(actor, 'swarm.create')) return fail('forbidden', 'Нет права на создание роя');
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
      const { budgetMicroUsd, maxTokens } = parsed.data;
      if (budgetMicroUsd > deps.limits.maxBudgetMicroUsd) {
        return fail('validation_error', 'budget exceeds SWARM_MAX_BUDGET_MICRO_USD');
      }
      if (
        parsed.data.agents.some(
          (a) => a.budgetMicroUsd !== null && a.budgetMicroUsd > budgetMicroUsd,
        )
      ) {
        return fail('validation_error', 'agent budget exceeds swarm budget');
      }
      if (
        [maxTokens, ...parsed.data.agents.map((a) => a.maxTokens)].some(
          (tokens) => tokens !== null && tokens > deps.limits.maxTokens,
        )
      ) {
        return fail('validation_error', 'max_tokens exceeds AGENT_MAX_TOKENS_LIMIT');
      }
      if (actor.orgId === null) return fail('forbidden', 'У создателя роя нет организации');
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
        if ((await billing.reserve(actor.orgId, swarmId, budgetMicroUsd)) === 'insufficient') {
          return fail('insufficient_balance', 'balance is not enough for budget');
        }
        const created = await commit(swarmId, {
          id: ids.uuid(),
          swarmId,
          ts,
          source: 'api',
          agentId: null,
          traceId: trace.currentTraceId(),
          type: 'swarm.created',
          data: {
            task: parsed.data.task,
            budgetMicroUsd,
            maxTokens,
            agents,
            orgId: actor.orgId,
            createdBy: actor.userId,
          },
        });
        if (created === null) {
          try {
            await billing.settle(swarmId, 0);
          } catch (err) {
            log.error('billing_settle_failed', { swarmId, err });
          }
          throw new Error('swarm.created не записан');
        }
        log.info('swarm created', { swarmId, agents: agents.length });

        try {
          await orchestrator.launch({
            swarmId,
            task: parsed.data.task,
            budgetMicroUsd,
            maxTokens,
            agents,
          });
        } catch (error) {
          log.error('orchestrator unavailable', { swarmId, err: error });
          try {
            await orchestrator.stop(swarmId);
          } catch (err) {
            log.warn('launch_stop_failed', { swarmId, err });
          }
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
      } finally {
        reserving -= 1;
      }
      return ok((await store.view(swarmId)) as SwarmView);
    },

    // У всех ролей есть swarm.read (4.1), поэтому без права список пуст, а не forbidden: сигнатура 4.4 без Result.
    async listSwarms(actor) {
      if (!can(actor, 'swarm.read')) return [];
      return (await store.views())
        .filter((v) => visible(actor, v))
        .map((v) => ({
          id: v.id,
          task: v.task,
          status: v.status,
          agentCount: v.agents.length,
          createdAt: v.createdAt,
        }))
        .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
    },

    async getSwarm(actor, id) {
      if (!can(actor, 'swarm.read')) return fail('forbidden', 'Нет права на чтение роя');
      const view = await visibleView(actor, id);
      return view ? ok(view) : fail('not_found', `Рой ${id} не найден`);
    },

    async getEvents(actor, id, after) {
      if (!can(actor, 'swarm.read')) return fail('forbidden', 'Нет права на чтение роя');
      if (!(await visibleView(actor, id))) return fail('not_found', `Рой ${id} не найден`);
      return ok((await store.events(id, after)).map((e) => forActor(actor, e)));
    },

    async stopSwarm(actor, id) {
      if (!can(actor, 'swarm.stop')) return fail('forbidden', 'Нет права на остановку роя');
      const view = await visibleView(actor, id);
      if (!view) return fail('not_found', `Рой ${id} не найден`);
      if (FINAL_SWARM_STATUSES.includes(view.status)) {
        return fail('swarm_finished', `Рой уже ${view.status}`);
      }
      await orchestrator.stop(id);
      return ok(undefined);
    },

    // Спека 024, 4.4, правило 6: тот же путь, что stopSwarm, без проверки Actor. Сбой одного роя
    // не мешает остальным; в конце — AggregateError, повтор безопасен (остановленные рои уже финальные).
    async stopSwarmsOfUser(userId) {
      let stopped = 0;
      const errors: unknown[] = [];
      for (const view of await store.views()) {
        if (view.createdBy !== userId) continue;
        if (FINAL_SWARM_STATUSES.includes(view.status)) continue;
        try {
          await orchestrator.stop(view.id);
          stopped += 1;
        } catch (error) {
          log.warn('user_swarm_stop_failed', { userId, swarmId: view.id, err: error });
          errors.push(error);
        }
      }
      log.info('user_swarms_stopped', { userId, count: stopped });
      if (errors.length > 0) throw new AggregateError(errors, 'user swarms stop failed');
      return stopped;
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

    async subscribe(actor, swarmId, after, listener) {
      if (!can(actor, 'swarm.read')) return fail('forbidden', 'Нет права на чтение роя');
      if (!(await visibleView(actor, swarmId))) {
        return fail('not_found', `Рой ${swarmId} не найден`);
      }
      // Регистрация до чтения истории: события, записанные во время чтения, попадут в буфер (REQ-003-4).
      const sub: Subscriber = {
        listener: (e) => listener(forActor(actor, e)),
        reading: true,
        buffer: [],
        last: after,
        closed: false,
      };
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

    async settlePending() {
      let settled = 0;
      for (const hold of await billing.holds()) {
        try {
          const view = await store.view(hold.swarmId);
          if (view !== null && !FINAL_SWARM_STATUSES.includes(view.status)) continue;
          if (view === null) {
            await billing.settle(hold.swarmId, 0);
          } else {
            const event = (await store.events(hold.swarmId, 0))
              .filter((e) => FINAL_EVENT_TYPES.includes(e.type))
              .at(-1);
            if (event === undefined) throw new Error('итоговое событие роя не найдено');
            await billing.settle(hold.swarmId, await finalSpent(event, store, log));
          }
          settled += 1;
        } catch (err) {
          log.error('billing_settle_failed', { swarmId: hold.swarmId, err });
        }
      }
      return settled;
    },
  };
}
