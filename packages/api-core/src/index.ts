import {
  AgentSpec,
  BusMessage,
  NodeManifest,
  NodeTypeList,
  PlatformEventInput,
  ProcessGraph,
  SecretList,
  SecretName,
  SecretPutRequest,
  type SecretSummary,
  SwarmCreateRequest,
  SwarmGraphRequest,
  can,
  type Actor,
  type GraphCheckResult,
  type GraphIssue,
  type LaunchProgram,
  type PlatformEvent,
  type ServiceInfo,
  type SwarmLaunch,
  type SwarmSummary,
} from '@swag/contracts';
import {
  checkGraph,
  FINAL_SWARM_STATUSES,
  formGraph,
  type NodeRegistry,
  type SwarmView,
} from '@swag/api-integration';

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

// Спека 026, 4.6. Секреты организации: значение наружу не отдаётся. Адаптер — Postgres (adapter-postgres).
export interface SecretStore {
  list(orgId: string): Promise<SecretSummary[]>;
  put(
    orgId: string,
    name: SecretName,
    value: string,
    by: string,
    now: Date,
  ): Promise<SecretSummary>;
  delete(orgId: string, name: SecretName): Promise<boolean>; // false — не было
}

export interface ApiCoreDeps {
  version: string; // передаёт оболочка: ядро не читает package.json
  store: SwarmStore;
  orchestrator: OrchestratorClient;
  billing: Billing;
  secrets: SecretStore; // спека 026, 4.6: адаптер — createPostgresSecretStore
  clock: Clock;
  ids: IdGenerator;
  log: Logger;
  trace: TraceContext;
  nodeTypes: NodeRegistry; // спека 021, 4.6: каталог из @swag/api-integration; реестр собирает оболочка (4.7)
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
  checkGraphFor(actor: Actor, body: unknown): Promise<Result<GraphCheckResult>>; // 009, 4.9: POST /graph-checks
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
  listNodeTypes(actor: Actor): Result<NodeTypeList>; // 021, 4.6; реестр в памяти — синхронно
  getNodeType(actor: Actor, ref: string): Result<NodeManifest>;
  listSecrets(actor: Actor): Promise<Result<SecretList>>; // 026, 4.6
  putSecret(actor: Actor, name: string, body: unknown): Promise<Result<SecretSummary>>;
  deleteSecret(actor: Actor, name: string): Promise<Result<null>>;
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

// Ошибка разбора тела: пути и сообщения zod, как у прежнего validation_error.
const invalidBody = <T>(
  message: string,
  error: { issues: ReadonlyArray<{ path: ReadonlyArray<PropertyKey>; message: string }> },
): Result<T> =>
  fail(
    'validation_error',
    message,
    error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
  );

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
  const { store, orchestrator, billing, secrets, clock, ids, log, trace } = deps;
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

  // Спека 009, 4.9: тело — граф или форма; форма превращается в граф (formGraph) и дальше идёт тем же путём.
  // Вид тела различается по полю graph, а не через z.union: пути ошибок формы остаются прежними (AC-001-4, D-181).
  function parseRequest(body: unknown): Result<SwarmGraphRequest> {
    if (typeof body === 'object' && body !== null && 'graph' in body) {
      const parsed = SwarmGraphRequest.safeParse(body);
      return parsed.success
        ? ok(parsed.data)
        : invalidBody('Запрос на рой не прошёл проверку', parsed.error);
    }
    const parsed = SwarmCreateRequest.safeParse(body);
    if (!parsed.success) return invalidBody('Запрос на рой не прошёл проверку', parsed.error);
    const { task, budgetMicroUsd, maxTokens, agents } = parsed.data;
    return ok({ task, budgetMicroUsd, maxTokens, graph: formGraph(agents) });
  }

  // Спека 009, 4.4: проверка графа; секреты — имена секретов организации, без orgId секретов нет.
  async function graphCheck(graph: ProcessGraph, orgId: string | null): Promise<GraphCheckResult> {
    const secretNames = new Set(
      orgId === null ? [] : (await secrets.list(orgId)).map((secret) => secret.name),
    );
    return checkGraph(graph, { registry: deps.nodeTypes, secretNames });
  }

  // Спека 009, 4.9, шаг 4: задача роя — вход шага-программы; проверка по схеме inputs этой программы.
  function entryInputIssues(graph: ProcessGraph, task: string): GraphIssue[] {
    const entry = graph.nodes.find((node) => node.id === graph.entry);
    if (!entry || deps.nodeTypes.get(entry.type)?.kind !== 'program') return [];
    const result = deps.nodeTypes.validate(entry.type, { place: 'inputs' }, { text: task });
    if (result.ok) return [];
    const message =
      result.error.code === 'invalid_value'
        ? result.error.issues
            .map((issue) => (issue.path ? `${issue.path}: ${issue.message}` : issue.message))
            .join('; ')
        : result.error.code;
    return [{ code: 'entry_input_invalid', path: 'entry', message }];
  }

  // Спека 009, 4.5: настройки узлов после validateSettings (с умолчаниями), порядок — узлов графа.
  // После checkGraph настройки проверены; иная ситуация — ошибка сервера.
  function launchNodes(graph: ProcessGraph): { agents: AgentSpec[]; programs: LaunchProgram[] } {
    const agents: AgentSpec[] = [];
    const programs: LaunchProgram[] = [];
    for (const node of graph.nodes) {
      const checked = deps.nodeTypes.validateSettings(node.type, node.settings);
      if (!checked.ok)
        throw new Error(`настройки узла ${node.id} не прошли проверку после checkGraph`);
      if (deps.nodeTypes.get(node.type)?.kind === 'llm-agent') {
        agents.push(AgentSpec.parse({ ...checked.settings, id: node.id }));
      } else {
        programs.push({
          id: node.id,
          type: node.type,
          settings: checked.settings,
          credentials: node.credentials,
        });
      }
    }
    return { agents, programs };
  }

  return {
    info: () => ({ service: 'api', version: deps.version }),

    async createSwarm(actor, body) {
      if (!can(actor, 'swarm.create')) return fail('forbidden', 'Нет права на создание роя');
      const parsed = parseRequest(body);
      if (!parsed.ok) return parsed;
      if (actor.orgId === null) return fail('forbidden', 'У создателя роя нет организации');
      const orgId = actor.orgId;
      const { task, budgetMicroUsd, maxTokens, graph } = parsed.value;
      const issues = [...(await graphCheck(graph, orgId)).issues, ...entryInputIssues(graph, task)];
      if (issues.length > 0) {
        return fail(
          'invalid_graph',
          'graph has issues',
          issues.map((issue) => ({ path: issue.path, message: `${issue.code}: ${issue.message}` })),
        );
      }
      const { agents, programs } = launchNodes(graph);
      if (budgetMicroUsd > deps.limits.maxBudgetMicroUsd) {
        return fail('validation_error', 'budget exceeds SWARM_MAX_BUDGET_MICRO_USD');
      }
      if (agents.some((a) => a.budgetMicroUsd !== null && a.budgetMicroUsd > budgetMicroUsd)) {
        return fail('validation_error', 'agent budget exceeds swarm budget');
      }
      if (
        [maxTokens, ...agents.map((a) => a.maxTokens)].some(
          (tokens) => tokens !== null && tokens > deps.limits.maxTokens,
        )
      ) {
        return fail('validation_error', 'max_tokens exceeds AGENT_MAX_TOKENS_LIMIT');
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
      let slotHeld = true;
      const releaseSlot = (): void => {
        if (!slotHeld) return;
        slotHeld = false;
        reserving -= 1;
      };

      const swarmId = ids.uuid();
      const ts = clock.now();
      try {
        if ((await billing.reserve(orgId, swarmId, budgetMicroUsd)) === 'insufficient') {
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
            task,
            budgetMicroUsd,
            maxTokens,
            agents,
            orgId,
            createdBy: actor.userId,
            graph,
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
        releaseSlot();
        log.info('swarm created', { swarmId, agents: agents.length });

        try {
          await orchestrator.launch({
            swarmId,
            orgId,
            task,
            budgetMicroUsd,
            maxTokens,
            agents,
            programs,
            edges: graph.edges,
            entry: graph.entry,
            exit: graph.exit,
            trigger: null,
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
        releaseSlot();
      }
      return ok((await store.view(swarmId)) as SwarmView);
    },

    // Спека 009, 4.9: та же проверка графа без резерва, запуска и событий; нужна редактору и координатору.
    async checkGraphFor(actor, body) {
      if (!can(actor, 'swarm.create')) return fail('forbidden', 'Нет права на создание роя');
      const parsed = ProcessGraph.safeParse(body);
      if (!parsed.success) return invalidBody('Граф не прошёл проверку', parsed.error);
      return ok(await graphCheck(parsed.data, actor.orgId));
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

    // Спека 021, 4.6. У всех ролей есть node.read, но проверка права остаётся в ядре (AC-021-20).
    listNodeTypes(actor) {
      if (!can(actor, 'node.read')) return fail('forbidden', 'Нет права на чтение каталога узлов');
      return ok({ items: deps.nodeTypes.list() });
    },

    getNodeType(actor, ref) {
      if (!can(actor, 'node.read')) return fail('forbidden', 'Нет права на чтение каталога узлов');
      const manifest = deps.nodeTypes.get(ref);
      return manifest ? ok(manifest) : fail('not_found', 'Тип узла не найден');
    },

    // Спека 026, 4.6: право secret.manage — первая проверка; организация — только actor.orgId.
    async listSecrets(actor) {
      if (!can(actor, 'secret.manage') || actor.orgId === null) {
        return fail('forbidden', 'Нет права на управление секретами');
      }
      return ok({ items: await secrets.list(actor.orgId) });
    },

    async putSecret(actor, name, body) {
      if (!can(actor, 'secret.manage') || actor.orgId === null) {
        return fail('forbidden', 'Нет права на управление секретами');
      }
      const parsedName = SecretName.safeParse(name);
      const parsedBody = SecretPutRequest.safeParse(body);
      if (!parsedName.success || !parsedBody.success) {
        return fail('invalid_request', 'Имя или тело секрета не прошли проверку');
      }
      return ok(
        await secrets.put(
          actor.orgId,
          parsedName.data,
          parsedBody.data.value,
          actor.userId,
          new Date(clock.now()),
        ),
      );
    },

    // Спека 026, 4.6: у DELETE в таблице нет 400, поэтому имя не по SecretName даёт not_found (трактовка, журнал).
    async deleteSecret(actor, name) {
      if (!can(actor, 'secret.manage') || actor.orgId === null) {
        return fail('forbidden', 'Нет права на управление секретами');
      }
      const parsedName = SecretName.safeParse(name);
      const removed = parsedName.success && (await secrets.delete(actor.orgId, parsedName.data));
      return removed ? ok(null) : fail('not_found', 'Секрет не найден');
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
            const event = (await store.events(hold.swarmId, 0)).find((e) =>
              FINAL_EVENT_TYPES.includes(e.type),
            );
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
