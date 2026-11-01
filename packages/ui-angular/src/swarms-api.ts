import type { PlatformEvent, SwarmCreateRequest, SwarmSummary } from '@swag/contracts';
import type { EventStream, SwarmsApi } from '@swag/ui-core';
import type { SwarmView } from '@swag/api-integration';
import { createRequest, type RequestSession } from './http.ts';

// Адаптеры UI к API роёв и потока: REST и WebSocket идут по относительному пути /api (прокси снимает префикс).
// Спека 024, 4.15: каждый запрос с Bearer-токеном сессии; на 401 — renew и один повтор (`createRequest`).

export function createSwarmsApi(session: RequestSession): SwarmsApi {
  const request = createRequest(session, '/api');
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
export function createSwarmStream(session: RequestSession): EventStream {
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
