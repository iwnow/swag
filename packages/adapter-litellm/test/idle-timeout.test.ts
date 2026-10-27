import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startFakeProvider } from '../../../infra/llm/fake-provider/server.ts';
import { createLiteLlmUpstream } from '../src/index.ts';

// Спека 002, 4.5: таймаут простоя и внешний abort. Тесты без AC-id: AC-002-16 описывает 504 шлюза (T-16, T-20).
const MASTER_KEY = 'sk-swag-local-not-secret';

type Fake = Awaited<ReturnType<typeof startFakeProvider>>;

let fake: Fake;
const servers: Server[] = [];

beforeEach(async () => {
  fake = await startFakeProvider({ port: 0 });
});

afterEach(async () => {
  await fake.close();
  for (const server of servers.splice(0)) {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
      server.closeAllConnections();
    });
  }
});

const upstreamFor = (baseUrl: string, idleTimeoutMs: number) =>
  createLiteLlmUpstream({
    baseUrl,
    masterKey: MASTER_KEY,
    idleTimeoutMs,
    secrets: [MASTER_KEY],
  });

const hangRequest = {
  model: 'fake-small',
  messages: [{ role: 'user', content: '__hang__' }],
};

const signal = () => new AbortController().signal;

async function listen(server: Server): Promise<string> {
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

// Настоящий сервер: заголовки и тело приходят кусками с паузой `gapMs`, как у медленного апстрима.
function trickleServer(gapMs: number, chunks: string[]): Promise<string> {
  return listen(
    createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      const send = (index: number) => {
        if (res.destroyed) return;
        if (index === chunks.length) return res.end();
        res.write(chunks[index]);
        setTimeout(() => send(index + 1), gapMs);
      };
      send(0);
    }),
  );
}

// Настоящий сервер, который не отвечает никогда.
function hangingServer(): Promise<string> {
  return listen(createServer(() => {}));
}

describe('complete: таймаут простоя (спека 002, 4.5, REQ-002-10)', () => {
  it('__hang__ при idleTimeoutMs 200 — timeout за 200–1000 мс', async () => {
    const started = Date.now();

    const result = await upstreamFor(fake.url, 200).complete(hangRequest, signal());

    const elapsed = Date.now() - started;
    expect(result).toEqual({ ok: false, failure: { kind: 'timeout' } });
    expect(elapsed).toBeGreaterThanOrEqual(200);
    expect(elapsed).toBeLessThan(1000);
  });

  it('таймер перезапускается на каждом куске: тело частями по 100 мс при idleTimeoutMs 250 — ok', async () => {
    const url = await trickleServer(100, ['{"object":', '"chat.completion",', '"choices":[]}']);

    const result = await upstreamFor(url, 250).complete(hangRequest, signal());

    expect(result).toEqual({ ok: true, body: { object: 'chat.completion', choices: [] } });
  });

  it('пауза между кусками тела больше idleTimeoutMs — timeout, даже если начало пришло', async () => {
    const url = await trickleServer(400, ['{"object":', '"chat.completion"}']);

    const result = await upstreamFor(url, 200).complete(hangRequest, signal());

    expect(result).toEqual({ ok: false, failure: { kind: 'timeout' } });
  });

  it('внешний abort через 50 мс — network быстро, не timeout', async () => {
    const controller = new AbortController();
    const started = Date.now();
    setTimeout(() => controller.abort(), 50);

    const result = await upstreamFor(fake.url, 120_000).complete(hangRequest, controller.signal);

    expect(result).toEqual({ ok: false, failure: { kind: 'network' } });
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('уже прерванный внешний signal — network', async () => {
    const controller = new AbortController();
    controller.abort();

    const result = await upstreamFor(fake.url, 120_000).complete(hangRequest, controller.signal);

    expect(result).toEqual({ ok: false, failure: { kind: 'network' } });
  });

  it('внешний abort во время чтения тела — network', async () => {
    const url = await trickleServer(300, ['{"object":', '"chat.completion"}']);
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 150);

    const result = await upstreamFor(url, 120_000).complete(hangRequest, controller.signal);

    expect(result).toEqual({ ok: false, failure: { kind: 'network' } });
  });
});

describe('listModels: таймаут простоя и внешний abort (спека 002, 4.5)', () => {
  it('нет ответа при idleTimeoutMs 200 — timeout за 200–1000 мс', async () => {
    const url = await hangingServer();
    const started = Date.now();

    const result = await upstreamFor(url, 200).listModels(signal());

    const elapsed = Date.now() - started;
    expect(result).toEqual({ ok: false, failure: { kind: 'timeout' } });
    expect(elapsed).toBeGreaterThanOrEqual(200);
    expect(elapsed).toBeLessThan(1000);
  });

  it('внешний abort через 50 мс — network', async () => {
    const url = await hangingServer();
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 50);

    const result = await upstreamFor(url, 120_000).listModels(controller.signal);

    expect(result).toEqual({ ok: false, failure: { kind: 'network' } });
  });
});
