import type { PlatformEvent, SwarmCreateRequest, SwarmSummary } from '@swag/contracts';
import type { AuthSessionKeeper, EventStream, SwarmsApi } from '@swag/ui-core';
import type { SwarmView } from '@swag/api-integration';

// Адаптеры UI к API: REST и WebSocket идут по относительному пути /api (прокси снимает префикс).
// Спека 024, 4.15: каждый запрос с Bearer-токеном сессии; на 401 — renew и один повтор.

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
      const message =
        (payload as { error?: { message?: string } } | undefined)?.error?.message ??
        `HTTP ${response.status}`;
      throw new Error(message);
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

// Спека 024, 4.6: токен в подпротоколе `swag.bearer.<token>`. Закрытие 4401 — обновить токен до переподключения.
export function createSwarmStream(session: AuthSessionKeeper): EventStream {
  return {
    open(swarmId, after, handlers) {
      const token = session.accessToken();
      if (token === null) {
        handlers.onError();
        return { close: () => undefined };
      }
      const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
      const socket = new WebSocket(
        `${scheme}://${location.host}/api/swarms/${encodeURIComponent(swarmId)}/stream?after=${after}`,
        ['swag.v1', `swag.bearer.${token}`],
      );
      socket.addEventListener('message', (message: MessageEvent<string>) => {
        handlers.onEvent(JSON.parse(message.data) as PlatformEvent);
      });
      socket.addEventListener('close', (event: CloseEvent) => {
        if (event.code === 4401) void session.renew();
        handlers.onError();
      });
      socket.addEventListener('error', () => undefined); // закрытие придёт отдельным событием
      return {
        close: () => socket.close(),
      };
    },
  };
}
