import {
  PlatformModel,
  SwarmCreateRequest,
  type LlmCallData,
  type PlatformEvent,
  type SwarmSummary,
} from '@swag/contracts';
import { applyEvent, type SwarmView } from '@swag/api-integration';

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

// Спека 022, 4.1 и 4.10: модели для выбора в форме роя — из контракта, без копии списка.
export const platformModels = PlatformModel.options;

export type AgentStepData = Extract<PlatformEvent, { type: 'agent.step' }>['data'];

// Спека 022, 4.10: строка шага агента в ленте роя.
export function formatAgentStep(data: AgentStepData): string {
  const text = data.text === null ? '' : `: ${data.text}`;
  const tools =
    data.toolCalls.length === 0 ? '' : ` → ${data.toolCalls.map((call) => call.name).join(', ')}`;
  return `шаг ${data.stepIndex}${text}${tools}`;
}

// Спека 002, 4.11: строка вызова модели в ленте роя. Стоимость — микродоллары / 1e6, 6 знаков.
export function formatLlmCall(data: LlmCallData): string {
  if (data.status === 'error') return `${data.model} · ошибка ${data.errorCode}`;
  const aborted = data.status === 'aborted';
  if (data.usage === null) return `${data.model} · ${aborted ? 'прерван · ' : ''}без usage`;
  const { promptTokens, cachedPromptTokens, completionTokens } = data.usage;
  const cost = ((data.costMicroUsd ?? 0) / 1e6).toFixed(6);
  const abortedMark = aborted ? ' · прерван' : '';
  return `${data.model} · ${promptTokens} (кэш ${cachedPromptTokens}) → ${completionTokens} ток. · $${cost}${abortedMark}`;
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
