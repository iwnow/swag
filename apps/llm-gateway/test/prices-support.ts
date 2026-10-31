import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { ModelCatalog } from '@swag/contracts';
import type { Logger, PriceStore, StoredPrice } from '@swag/llm-gateway-core';
import { readCatalog } from '../src/catalog.ts';
import { catalogPath } from './support.ts';
import {
  fakeClock,
  fakeIds,
  fakeTrace,
  fakeUpstream,
} from '../../../packages/llm-gateway-core/test/fakes.ts';

// Спека 004, 4.9: каталог фикстуры, у chat-small есть openRouterModel. Цены фикстуры: 3.00 / 0.30 / 15.00.
export const OPEN_ROUTER_SMALL = 'vendor/small';
export function catalogWithOpenRouter(): ModelCatalog {
  const base = readCatalog(catalogPath);
  return {
    models: base.models.map((model) =>
      model.id === 'chat-small' ? { ...model, openRouterModel: OPEN_ROUTER_SMALL } : model,
    ),
  };
}

// Ответ OpenRouter для vendor/small: prompt — USD за токен; completion и input_cache_read фиксированы.
export function openRouterBody(prompt: string): unknown {
  return {
    data: [
      {
        id: OPEN_ROUTER_SMALL,
        pricing: { prompt, completion: '0.000015', input_cache_read: '0.0000003' },
      },
    ],
  };
}

export interface FakeOpenRouter {
  url: string;
  requests(): number;
  reply(status: number, body?: unknown): void;
  // Удержать ответы до вызова release: запрос в полёте, клиент ждёт.
  hold(): () => void;
  close(): Promise<void>;
}

// Фейк OpenRouter на 127.0.0.1: ответ меняется тестом; считаются запросы.
export async function startFakeOpenRouter(
  status = 200,
  body: unknown = openRouterBody('0.000003'),
): Promise<FakeOpenRouter> {
  let current = { status, body };
  let count = 0;
  let held: Promise<void> | null = null;
  const server = createServer(async (_request, response) => {
    count += 1;
    const gate = held;
    if (gate) await gate;
    response.writeHead(current.status, { 'content-type': 'application/json' });
    response.end(JSON.stringify(current.body ?? {}));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/api/v1/models`,
    requests: () => count,
    reply(next, nextBody) {
      current = { status: next, body: nextBody };
    },
    hold() {
      let open: () => void = () => undefined;
      const gate = new Promise<void>((resolve) => {
        open = resolve;
      });
      held = gate;
      return () => {
        open();
        if (held === gate) held = null;
      };
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

// Хранилище цен в памяти: сохраняет вызовы save; setFailSave бросает.
export function memoryPriceStore(initial: StoredPrice[] = []): {
  store: PriceStore;
  saves: StoredPrice[][];
  setFailSave(fail: boolean): void;
} {
  const saves: StoredPrice[][] = [];
  let failSave = false;
  return {
    saves,
    setFailSave(fail) {
      failSave = fail;
    },
    store: {
      load: async () => initial,
      save: async (prices) => {
        saves.push(prices);
        if (failSave) throw new Error('db down');
      },
    },
  };
}

// Зависимости ядра для оболочки без Postgres: события не пишутся, часы фейковые.
export function gatewayDeps(catalog: ModelCatalog, log: Logger) {
  return {
    catalog,
    upstream: fakeUpstream(),
    events: { publishEvent: async () => undefined },
    clock: fakeClock(),
    ids: fakeIds(),
    trace: fakeTrace(),
    log,
    version: 'test',
    sleep: (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)), // спека 013, 4.7
    closeWaitMs: 5000,
  };
}
