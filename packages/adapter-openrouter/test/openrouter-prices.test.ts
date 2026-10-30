import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { HttpError } from '@swag/helpers/server';
import { createOpenRouterPrices } from '../src/index.ts';

// Спека 004, 4.9 и 4.10: фейковый сервер OpenRouter на 127.0.0.1, без сети. Ответы идут по очереди; последний повторяется.
interface Reply {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
  hang?: boolean;
}

interface Fake {
  url: string;
  requests: string[];
}

let server: Server | undefined;
const pending: ServerResponse[] = [];

async function startFake(replies: Reply[]): Promise<Fake> {
  const fake: Fake = { url: '', requests: [] };
  let index = 0;
  server = createServer((request: IncomingMessage, response: ServerResponse) => {
    fake.requests.push(request.url ?? '');
    const reply = replies[Math.min(index, replies.length - 1)] as Reply;
    index += 1;
    if (reply.hang) {
      pending.push(response);
      return;
    }
    response.writeHead(reply.status, { 'content-type': 'application/json', ...reply.headers });
    response.end(JSON.stringify(reply.body ?? {}));
  });
  await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  fake.url = `http://127.0.0.1:${port}/api/v1/models`;
  return fake;
}

afterEach(async () => {
  for (const response of pending.splice(0)) response.destroy();
  server?.closeAllConnections();
  await new Promise<void>((resolve) => server?.close(() => resolve()) ?? resolve());
  server = undefined;
});

const body = { data: [{ id: 'vendor/small', pricing: { prompt: '0.000003' } }] };
const quick = { attempts: 4, baseMs: 100, maxMs: 1000 };
const signal = () => new AbortController().signal;

describe('adapter-openrouter (спека 004, 4.9 и 4.10)', () => {
  it('ответ 200 отдаётся как JSON, запрос идёт по URL без ключа', async () => {
    const fake = await startFake([{ status: 200, body }]);
    const prices = createOpenRouterPrices({ url: fake.url, timeoutMs: 1000 });
    await expect(prices.fetchModels(signal())).resolves.toEqual(body);
    expect(fake.requests).toEqual(['/api/v1/models']);
  });

  it('500 повторяется с задержкой по формуле 4.10, затем успех', async () => {
    const fake = await startFake([{ status: 500 }, { status: 503 }, { status: 200, body }]);
    const sleeps: number[] = [];
    const prices = createOpenRouterPrices({
      url: fake.url,
      timeoutMs: 1000,
      retry: { ...quick, sleep: async (ms) => void sleeps.push(ms), random: () => 0.5 },
    });
    await expect(prices.fetchModels(signal())).resolves.toEqual(body);
    expect(fake.requests).toHaveLength(3);
    // baseMs 100: перед 2-й попыткой 0.5·100, перед 3-й 0.5·200
    expect(sleeps).toEqual([50, 100]);
  });

  it('400 не повторяется, ответ — HttpError со status', async () => {
    const fake = await startFake([{ status: 400 }]);
    const prices = createOpenRouterPrices({ url: fake.url, timeoutMs: 1000, retry: quick });
    const error = await prices.fetchModels(signal()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(HttpError);
    expect(error).toMatchObject({ status: 400, retryAfterMs: null });
    expect(fake.requests).toHaveLength(1);
  });

  it('429 с Retry-After: 2 — пауза не меньше 2000 мс, retryAfterMs в ошибке', async () => {
    const fake = await startFake([{ status: 429, headers: { 'retry-after': '2' } }]);
    const sleeps: number[] = [];
    const prices = createOpenRouterPrices({
      url: fake.url,
      timeoutMs: 1000,
      retry: { attempts: 2, sleep: async (ms) => void sleeps.push(ms), random: () => 0.5 },
    });
    const error = await prices.fetchModels(signal()).catch((e: unknown) => e);
    expect(error).toMatchObject({ status: 429, retryAfterMs: 2000 });
    expect(fake.requests).toHaveLength(2);
    expect(sleeps).toEqual([2000]);
  });

  it('таймаут одной попытки — ошибка TimeoutError, повторы по httpRetryable', async () => {
    const fake = await startFake([{ status: 200, hang: true }]);
    const prices = createOpenRouterPrices({
      url: fake.url,
      timeoutMs: 50,
      retry: { attempts: 2, baseMs: 1, sleep: async () => undefined, random: () => 0 },
    });
    const error = await prices.fetchModels(signal()).catch((e: unknown) => e);
    expect(error).toMatchObject({ name: 'TimeoutError' });
    expect(fake.requests).toHaveLength(2);
  });

  it('прерванный signal — запрос не уходит, причина прерывания отдаётся как ошибка', async () => {
    const fake = await startFake([{ status: 200, body }]);
    const controller = new AbortController();
    controller.abort(new Error('stopped'));
    const prices = createOpenRouterPrices({ url: fake.url, timeoutMs: 1000, retry: quick });
    await expect(prices.fetchModels(controller.signal)).rejects.toThrow('stopped');
    expect(fake.requests).toHaveLength(0);
  });
});
