import type { PlatformEvent, SwarmCreateRequest, SwarmSummary } from '@swag/contracts';
import type { EventStream, SwarmsApi, StreamHandlers } from '@swag/ui-core';
import type { SwarmView } from '@swag/api-integration';

// Адаптеры UI к API: REST и WebSocket идут по относительному пути /api (прокси снимает префикс).

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const response = await fetch(`/api${path}`, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload =
    response.status === 202 || response.status === 204 ? undefined : await response.json();
  if (!response.ok) {
    const message =
      (payload as { error?: { message?: string } } | undefined)?.error?.message ??
      `HTTP ${response.status}`;
    throw new Error(message);
  }
  return payload as T;
}

export const swarmsApi: SwarmsApi = {
  list: () => request<SwarmSummary[]>('GET', '/swarms'),
  create: (body: SwarmCreateRequest) => request<SwarmView>('POST', '/swarms', body),
  get: (id: string) => request<SwarmView>('GET', `/swarms/${encodeURIComponent(id)}`),
  stop: async (id: string) => {
    await request<void>('POST', `/swarms/${encodeURIComponent(id)}/stop`);
  },
};

export const swarmStream: EventStream = {
  open(swarmId: string, after: number, handlers: StreamHandlers) {
    const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
    const socket = new WebSocket(
      `${scheme}://${location.host}/api/swarms/${encodeURIComponent(swarmId)}/stream?after=${after}`,
    );
    socket.addEventListener('message', (message: MessageEvent<string>) => {
      handlers.onEvent(JSON.parse(message.data) as PlatformEvent);
    });
    socket.addEventListener('close', () => handlers.onError());
    socket.addEventListener('error', () => undefined); // закрытие придёт отдельным событием
    return {
      close: () => socket.close(),
    };
  },
};
