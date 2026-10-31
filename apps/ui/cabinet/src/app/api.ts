import type {
  BalanceEntry,
  BalanceEntryList,
  BalanceView,
  PlatformEvent,
  SwarmCreateRequest,
  SwarmSummary,
  TopupRequest,
} from '@swag/contracts';
import type { AuthSessionKeeper, EventStream, SwarmsApi } from '@swag/ui-core';
import type { SwarmView } from '@swag/api-integration';

// Адаптеры UI к API: REST и WebSocket идут по относительному пути /api (прокси снимает префикс).
// Спека 024, 4.15: каждый запрос с Bearer-токеном сессии; на 401 — renew и один повтор.

// Ошибка ответа API: статус и код из тела `{ error: { code, message } }` (спека 013, 4.11: ветка 402).
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | null,
    message: string,
  ) {
    super(message);
  }
}

function createRequest(session: AuthSessionKeeper) {
  const send = (method: string, path: string, body?: unknown): Promise<Response> => {
    const token = session.accessToken();
    return fetch(`/api${path}`, {
      method,
      headers: {
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(token === null ? {} : { authorization: `Bearer ${token}` }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  };

  // Неудачный renew сам выводит на /login через onSignedOut (App).
  return async <T>(method: string, path: string, body?: unknown): Promise<T> => {
    let response = await send(method, path, body);
    if (response.status === 401 && (await session.renew())) {
      response = await send(method, path, body);
    }
    const payload =
      response.status === 202 || response.status === 204 ? undefined : await response.json();
    if (!response.ok) {
      const error = (payload as { error?: { code?: string; message?: string } } | undefined)?.error;
      throw new ApiError(
        response.status,
        error?.code ?? null,
        error?.message ?? `HTTP ${response.status}`,
      );
    }
    return payload as T;
  };
}

export function createSwarmsApi(session: AuthSessionKeeper): SwarmsApi {
  const request = createRequest(session);
  return {
    list: () => request<SwarmSummary[]>('GET', '/swarms'),
    create: (body: SwarmCreateRequest) => request<SwarmView>('POST', '/swarms', body),
    get: (id: string) => request<SwarmView>('GET', `/swarms/${encodeURIComponent(id)}`),
    stop: async (id: string) => {
      await request<void>('POST', `/swarms/${encodeURIComponent(id)}/stop`);
    },
  };
}

// Спека 013, 4.11: баланс организации — тот же способ токена и разбора ошибок, что у `/swarms`.
export function createBalanceApi(session: AuthSessionKeeper) {
  const request = createRequest(session);
  return {
    getBalance: (orgId: string) =>
      request<BalanceView>('GET', `/organizations/${encodeURIComponent(orgId)}/balance`),
    listBalanceEntries: (orgId: string, before: number | null) => {
      const query = before === null ? '' : `?before=${before}`;
      return request<BalanceEntryList>(
        'GET',
        `/organizations/${encodeURIComponent(orgId)}/balance/entries${query}`,
      );
    },
    topup: (orgId: string, body: TopupRequest) =>
      request<BalanceEntry>(
        'POST',
        `/organizations/${encodeURIComponent(orgId)}/balance/topups`,
        body,
      ),
  };
}

export type BalanceApi = ReturnType<typeof createBalanceApi>;

// Спека 024, 4.6: токен в подпротоколе `swag.bearer.<token>`. Закрытие 4401 — обновить токен до переподключения.
export function createSwarmStream(session: AuthSessionKeeper): EventStream {
  return {
    open(swarmId, after, handlers) {
      const token = session.accessToken();
      // Сессии нет: переподключаться незачем, onSignedOut уведёт на /login (иначе ui-core крутил бы таймер бесконечно).
      if (token === null) return { close: () => undefined };
      const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
      const socket = new WebSocket(
        `${scheme}://${location.host}/api/swarms/${encodeURIComponent(swarmId)}/stream?after=${after}`,
        ['swag.v1', `swag.bearer.${token}`],
      );
      socket.addEventListener('message', (message: MessageEvent<string>) => {
        handlers.onEvent(JSON.parse(message.data) as PlatformEvent);
      });
      socket.addEventListener('close', (event: CloseEvent) => {
        if (event.code !== 4401) {
          handlers.onError();
          return;
        }
        // Переподключение только после удачного renew; неудача — onSignedOut уведёт на /login.
        void session.renew().then((renewed) => {
          if (renewed) handlers.onError();
        });
      });
      socket.addEventListener('error', () => undefined); // закрытие придёт отдельным событием
      return {
        close: () => socket.close(),
      };
    },
  };
}
