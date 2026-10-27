import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { chatRequest, signal, upstreamFor, useFake } from './helpers.ts';

// Спека 002, 4.5: таймаут простоя и внешний abort. Тесты без AC-id: AC-002-16 описывает 504 шлюза (T-16, T-20).

const fake = useFake();
const servers: Server[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
      server.closeAllConnections();
    });
  }
});

const hang = chatRequest('__hang__');

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
    const started = performance.now();

    const result = await upstreamFor(fake.current.url, { idleTimeoutMs: 200 }).complete(
      hang,
      signal(),
    );

    const elapsed = performance.now() - started;
    expect(result).toEqual({ ok: false, failure: { kind: 'timeout' } });
    expect(elapsed).toBeGreaterThanOrEqual(190);
    expect(elapsed).toBeLessThan(1000);
  });

  it('таймер перезапускается на каждом куске: тело частями по 100 мс при idleTimeoutMs 250 — ok', async () => {
    const url = await trickleServer(100, ['{"object":', '"chat.completion",', '"choices":[]}']);

    const result = await upstreamFor(url, { idleTimeoutMs: 250 }).complete(hang, signal());

    expect(result).toEqual({ ok: true, body: { object: 'chat.completion', choices: [] } });
  });

  it('пауза между кусками тела больше idleTimeoutMs — timeout, даже если начало пришло', async () => {
    const url = await trickleServer(400, ['{"object":', '"chat.completion"}']);

    const result = await upstreamFor(url, { idleTimeoutMs: 200 }).complete(hang, signal());

    expect(result).toEqual({ ok: false, failure: { kind: 'timeout' } });
  });

  it('D-51: не-2xx, у которого сервер обрывает тело, — network, не timeout', async () => {
    const url = await listen(
      createServer((_req, res) => {
        res.writeHead(502, { 'content-type': 'application/json' });
        res.write('{"error":{"mes');
        setTimeout(() => res.socket?.destroy(), 50);
      }),
    );

    const result = await upstreamFor(url).complete(chatRequest('привет'), signal());

    expect(result).toEqual({ ok: false, failure: { kind: 'network' } });
  });

  it('внешний abort через 50 мс — network быстро, не timeout', async () => {
    const controller = new AbortController();
    const started = performance.now();
    setTimeout(() => controller.abort(), 50);

    const result = await upstreamFor(fake.current.url).complete(hang, controller.signal);

    expect(result).toEqual({ ok: false, failure: { kind: 'network' } });
    expect(performance.now() - started).toBeLessThan(1000);
  });

  it('уже прерванный внешний signal — network', async () => {
    const controller = new AbortController();
    controller.abort();

    const result = await upstreamFor(fake.current.url).complete(hang, controller.signal);

    expect(result).toEqual({ ok: false, failure: { kind: 'network' } });
  });

  it('внешний abort во время чтения тела — network', async () => {
    const url = await trickleServer(300, ['{"object":', '"chat.completion"}']);
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 150);

    const result = await upstreamFor(url).complete(hang, controller.signal);

    expect(result).toEqual({ ok: false, failure: { kind: 'network' } });
  });
});

describe('listModels: таймаут простоя и внешний abort (спека 002, 4.5)', () => {
  it('нет ответа при idleTimeoutMs 200 — timeout за 200–1000 мс', async () => {
    const url = await hangingServer();
    const started = performance.now();

    const result = await upstreamFor(url, { idleTimeoutMs: 200 }).listModels(signal());

    const elapsed = performance.now() - started;
    expect(result).toEqual({ ok: false, failure: { kind: 'timeout' } });
    expect(elapsed).toBeGreaterThanOrEqual(190);
    expect(elapsed).toBeLessThan(1000);
  });

  it('внешний abort через 50 мс — network', async () => {
    const url = await hangingServer();
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 50);

    const result = await upstreamFor(url).listModels(controller.signal);

    expect(result).toEqual({ ok: false, failure: { kind: 'network' } });
  });
});
