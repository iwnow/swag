import {
  SwarmCreateRequest,
  type LlmCallData,
  type PlatformEvent,
  type PlatformModel,
  type SwarmStatus,
  type SwarmSummary,
} from '@swag/contracts';
import { applyEvent, type SwarmView } from '@swag/api-integration';

export * from './auth-session.ts';

// Спека 001, 4.8. Логика UI: валидация формы, состояние роя из событий, переподключение потока.
// Angular-компоненты только рисуют и передают действия сюда.

export interface SwarmsApi {
  list(): Promise<SwarmSummary[]>;
  create(request: SwarmCreateRequest): Promise<SwarmView>;
  get(id: string): Promise<SwarmView>;
  stop(id: string): Promise<void>;
}

export interface StreamHandlers {
  onEvent(event: PlatformEvent): void;
  onError(): void; // поток оборвался — ядро переподключится с after = lastSeq
}

export interface EventStream {
  open(swarmId: string, after: number, handlers: StreamHandlers): { close(): void };
}

export interface Timers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(id: unknown): void;
}

export interface UiCoreDeps {
  api: SwarmsApi;
  stream: EventStream;
  timers: Timers;
  reconnectMs?: number; // по спеке 1 с
  // Спека 016, 4.10: шаблон адреса трейса в Grafana с подстановкой {traceId}.
  traces: { urlTemplate: string };
}

export interface FormIssue {
  path: string;
  message: string;
}

export type FormResult =
  { ok: true; value: SwarmCreateRequest } | { ok: false; issues: FormIssue[] };

export interface SwarmPage {
  readonly view: SwarmView | null;
  readonly feed: readonly PlatformEvent[];
  readonly connected: boolean;
  onChange(listener: () => void): () => void;
  stop(): Promise<void>;
  close(): void;
}

export interface UiCore {
  validateForm(input: unknown): FormResult;
  createSwarm(input: unknown): Promise<FormResult & { view?: SwarmView }>;
  listSwarms(): Promise<SwarmSummary[]>;
  openSwarm(id: string): SwarmPage;
  traceUrl(traceId: string | null): string | null; // ссылка «Трейс»; без traceId — null
}

const TRACE_ID_SLOT = '{traceId}';

export type AgentStepData = Extract<PlatformEvent, { type: 'agent.step' }>['data'];

// Спека 022, 4.10: строка шага агента в ленте роя.
export function formatAgentStep(data: AgentStepData): string {
  const text = data.text === null ? '' : `: ${data.text}`;
  const tools =
    data.toolCalls.length === 0 ? '' : ` → ${data.toolCalls.map((call) => call.name).join(', ')}`;
  return `шаг ${data.stepIndex}${text}${tools}`;
}

// Спека 004, 4.8: микродоллары → строка с 4 знаками, округление вверх; целочисленная арифметика.
export function formatUsd(microUsd: number): string {
  const units = Math.floor((microUsd + 99) / 100);
  return `$${Math.floor(units / 10000)}.${String(units % 10000).padStart(4, '0')}`;
}

// Спека 004, 4.8: вход поля «Бюджет, $» → Math.round(usd × 10⁶). Некорректный ввод → NaN, отсекает SwarmCreateRequest.
export function usdToMicro(usd: string): number {
  const text = usd.trim();
  if (!/^\d+(\.\d+)?$/.test(text)) return NaN;
  return Math.round(Number(text) * 1e6);
}

// Спека 004, 4.8: charge событий llm.call с ts в (nowMs − 60000, nowMs]; без charge — costMicroUsd ?? 0 (как в 4.7).
export function spentLastMinute(events: readonly PlatformEvent[], nowMs: number): number {
  let spent = 0;
  for (const event of events) {
    if (event.type !== 'llm.call') continue;
    const ts = Date.parse(event.ts);
    if (!(ts > nowMs - 60000 && ts <= nowMs)) continue;
    spent += event.data.charge?.microUsd ?? event.data.costMicroUsd ?? 0;
  }
  return spent;
}

// Спека 004, 4.8: строка панели роя.
export function formatSwarmMoney(view: SwarmView, lastMinuteMicroUsd: number): string {
  const spent = formatUsd(view.spentMicroUsd);
  const minute = `${formatUsd(lastMinuteMicroUsd)} за минуту`;
  if (view.budgetMicroUsd === undefined) return `${spent} · бюджет — · ${minute}`;
  const left = Math.floor(Math.max(0, view.budgetMicroUsd - view.spentMicroUsd) / 100) * 100;
  return `${spent} из ${formatUsd(view.budgetMicroUsd)} · остаток ${formatUsd(left)} · ${minute}`;
}

// Спека 004, 4.8: поле формы роя — микро-USD агента; пустой бюджет агента — null (бюджета нет).
export interface AgentInput {
  name: string;
  role: string;
  model: PlatformModel;
  budget: string; // «Бюджет агента, $»: пустое — бюджета нет
  maxTokens: string; // «Лимит ответа, токенов»: пустое — значение роя
}

export function agentBudgetMicro(budget: string): number | null {
  return budget.trim() === '' ? null : usdToMicro(budget);
}

// Спека 031, 4.5: пустое поле — null (значение по умолчанию), иначе целое; нечисловое — NaN, его отсекает SwarmCreateRequest.
export function maxTokensInput(text: string): number | null {
  const trimmed = text.trim();
  if (trimmed === '') return null;
  return /^\d+$/.test(trimmed) ? Number(trimmed) : NaN;
}

// Спека 004, 4.8; лимит ответа — спека 031, 4.5: вход формы (доллары и токены строками) → поля SwarmCreateRequest.
export function swarmFormInput(
  task: string,
  budget: string,
  maxTokens: string,
  agents: AgentInput[],
): unknown {
  return {
    task,
    budgetMicroUsd: usdToMicro(budget),
    maxTokens: maxTokensInput(maxTokens),
    agents: agents.map(({ budget: agentBudget, maxTokens: agentMaxTokens, ...agent }) => ({
      ...agent,
      budgetMicroUsd: agentBudgetMicro(agentBudget),
      maxTokens: maxTokensInput(agentMaxTokens),
    })),
  };
}

// Спека 004, 4.8: тексты причин swarm.failed; остальные причины выводятся как пришли.
const FAILURE_REASON_TEXT: Record<string, string> = {
  budget_exceeded: 'бюджет исчерпан',
  gateway_unavailable: 'шлюз моделей недоступен',
};

export function failureReasonText(reason: string): string {
  return FAILURE_REASON_TEXT[reason] ?? reason;
}

function formatMicroUsd6(microUsd: number): string {
  return `$${Math.floor(microUsd / 1e6)}.${String(microUsd % 1e6).padStart(6, '0')}`;
}

// Спека 002, 4.11 (изменено 004, 4.8): строка вызова модели в ленте роя. Сумма — charge, иначе costMicroUsd.
export function formatLlmCall(data: LlmCallData): string {
  if (data.status === 'error') return `${data.model} · ошибка ${data.errorCode}`;
  const aborted = data.status === 'aborted';
  const micro = data.charge?.microUsd ?? data.costMicroUsd ?? 0;
  if (data.usage === null) {
    const head = `${data.model} · ${aborted ? 'прерван · ' : ''}без usage`;
    return data.charge?.basis === 'estimate' ? `${head} · ≈${formatMicroUsd6(micro)}` : head;
  }
  const { promptTokens, cachedPromptTokens, completionTokens } = data.usage;
  const abortedMark = aborted ? ' · прерван' : '';
  return `${data.model} · ${promptTokens} (кэш ${cachedPromptTokens}) → ${completionTokens} ток. · ${formatMicroUsd6(micro)}${abortedMark}`;
}

const FINAL_SWARM_STATUSES: ReadonlySet<SwarmStatus> = new Set(['completed', 'failed', 'stopped']);

// Спека 030, 4.4: id событий bus.message, которые получатель не начал обрабатывать; пусто, пока рой не в конечном статусе.
export function unreadMessageIds(
  feed: readonly PlatformEvent[],
  status: SwarmStatus,
): ReadonlySet<string> {
  const unread = new Set<string>();
  if (!FINAL_SWARM_STATUSES.has(status)) return unread;
  const started = new Set(
    feed.flatMap((event) => (event.type === 'agent.working' ? [event.data.messageId] : [])),
  );
  for (const event of feed) {
    if (event.type === 'bus.message' && !started.has(event.data.messageId)) unread.add(event.id);
  }
  return unread;
}

export function createUiCore(deps: UiCoreDeps): UiCore {
  const reconnectMs = deps.reconnectMs ?? 1000;

  const validateForm = (input: unknown): FormResult => {
    const parsed = SwarmCreateRequest.safeParse(input);
    if (parsed.success) return { ok: true, value: parsed.data };
    return {
      ok: false,
      issues: parsed.error.issues.map((issue) => ({
        path: issue.path.join('.'),
        message: issue.message,
      })),
    };
  };

  function openSwarm(id: string): SwarmPage {
    let view: SwarmView | null = null;
    const feed: PlatformEvent[] = [];
    let connected = false;
    let closed = false;
    let handle: { close(): void } | null = null;
    let timer: unknown = null;
    const listeners = new Set<() => void>();
    const notify = () => {
      for (const listener of listeners) listener();
    };

    const connect = (): void => {
      if (closed) return;
      const after = view?.lastSeq ?? 0;
      handle = deps.stream.open(id, after, {
        onEvent: (event) => {
          if (closed || (view !== null && event.seq <= view.lastSeq)) return; // повтор после переподключения
          try {
            view = applyEvent(view, event);
          } catch {
            return; // событие не к месту (например, до swarm.created) — пропускаем
          }
          feed.push(event);
          connected = true;
          notify();
        },
        onError: () => {
          handle = null;
          connected = false;
          notify();
          if (!closed) {
            timer = deps.timers.setTimeout(() => {
              timer = null;
              connect();
            }, reconnectMs);
          }
        },
      });
    };
    connect();

    return {
      get view() {
        return view;
      },
      get feed() {
        return feed;
      },
      get connected() {
        return connected;
      },
      onChange(listener) {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
      async stop() {
        await deps.api.stop(id);
      },
      close() {
        closed = true;
        handle?.close();
        if (timer !== null) deps.timers.clearTimeout(timer);
        listeners.clear();
      },
    };
  }

  return {
    validateForm,
    async createSwarm(input) {
      const result = validateForm(input);
      if (!result.ok) return result;
      const view = await deps.api.create(result.value);
      return { ok: true, value: result.value, view };
    },
    listSwarms: () => deps.api.list(),
    openSwarm,
    traceUrl: (traceId) =>
      traceId === null
        ? null
        : deps.traces.urlTemplate.split(TRACE_ID_SLOT).join(encodeURIComponent(traceId)),
  };
}
