import { SwarmCreateRequest, type PlatformEvent, type SwarmSummary } from '@swag/contracts';
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
  };
}
