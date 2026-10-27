import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.ts';
import { readCatalog } from '../src/catalog.ts';
import { startGateway, upstreamSecrets, waitForUpstream } from '../src/start.ts';
import { startFakeProvider } from '../../../infra/llm/fake-provider/server.ts';
import { MASTER_KEY, catalogPath, gatewayOptions, makeCore, recordingLog } from './support.ts';

// Спека 002, 4.2 (/health), 4.9, REQ-002-13: старт со сверкой каталога с апстримом.

const fixture = (name: string) => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));

function thrownBy(fn: () => unknown): Error {
  try {
    fn();
  } catch (error) {
    return error as Error;
  }
  throw new Error('ожидалась ошибка');
}

describe('старт шлюза против фейка (спека 002, REQ-002-13)', () => {
  it('AC-002-18: в апстриме нет chat-large → порт не слушается, error upstream_models_mismatch, выход с кодом 1', async () => {
    const fake = await startFakeProvider({ port: 0, models: ['chat-small'] });
    const { log, entries } = recordingLog();
    const exits: number[] = [];
    const core = makeCore(fake.url, log);
    const app = await buildApp(core, gatewayOptions);

    const started = performance.now();
    const listening = await startGateway({
      core,
      app,
      port: 0,
      host: '127.0.0.1',
      startupTimeoutMs: 500,
      log,
      exit: (code) => void exits.push(code),
    });
    const elapsed = performance.now() - started;

    expect(listening).toBe(false);
    expect(app.server.listening).toBe(false);
    expect(elapsed).toBeGreaterThanOrEqual(450);
    expect(elapsed).toBeLessThan(2000);
    expect(exits).toEqual([1]);
    expect(entries).toContainEqual({
      level: 'error',
      msg: 'upstream_models_mismatch',
      ctx: { missing: ['chat-large'] },
    });
    await app.close();
    await fake.close();
  });

  it('AC-002-18: все модели каталога есть → порт слушает, GET /health → 200', async () => {
    const fake = await startFakeProvider({ port: 0 });
    const { log, entries } = recordingLog();
    const exits: number[] = [];
    const core = makeCore(fake.url, log);
    const app = await buildApp(core, gatewayOptions);

    const listening = await startGateway({
      core,
      app,
      port: 0,
      host: '127.0.0.1',
      startupTimeoutMs: 500,
      log,
      exit: (code) => void exits.push(code),
    });
    const address = app.server.address();
    const port = typeof address === 'object' && address !== null ? address.port : 0;
    const response = await fetch(`http://127.0.0.1:${port}/health`);

    expect(listening).toBe(true);
    expect(exits).toEqual([]);
    expect(entries.filter((entry) => entry.level === 'error')).toEqual([]);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      status: 'ok',
      service: 'llm-gateway',
      version: 'test',
    });
    await app.close();
    await fake.close();
  });

  it('D-64: апстрим недоступен → порт не слушается, error upstream_unavailable с reason, выход с кодом 1', async () => {
    const { log, entries } = recordingLog();
    const exits: number[] = [];
    const core = makeCore('http://127.0.0.1:1', log);
    const app = await buildApp(core, gatewayOptions);

    const listening = await startGateway({
      core,
      app,
      port: 0,
      host: '127.0.0.1',
      startupTimeoutMs: 500,
      log,
      exit: (code) => void exits.push(code),
    });

    expect(listening).toBe(false);
    expect(app.server.listening).toBe(false);
    expect(exits).toEqual([1]);
    expect(entries).toContainEqual({
      level: 'error',
      msg: 'upstream_unavailable',
      ctx: { reason: 'network' },
    });
    await app.close();
  });

  it('REQ-002-13: висящая сверка прерывается по дедлайну, старт не длится дольше startupTimeoutMs', async () => {
    const stalled: Server = createServer(() => undefined);
    await new Promise<void>((resolve) => stalled.listen(0, '127.0.0.1', resolve));
    const { port } = stalled.address() as AddressInfo;
    const { log, entries } = recordingLog();
    const exits: number[] = [];
    const core = makeCore(`http://127.0.0.1:${port}`, log);
    const app = await buildApp(core, gatewayOptions);

    const started = performance.now();
    const listening = await startGateway({
      core,
      app,
      port: 0,
      host: '127.0.0.1',
      startupTimeoutMs: 500,
      log,
      exit: (code) => void exits.push(code),
    });
    const elapsed = performance.now() - started;

    expect(listening).toBe(false);
    expect(app.server.listening).toBe(false);
    expect(elapsed).toBeGreaterThanOrEqual(450);
    expect(elapsed).toBeLessThan(1500);
    expect(exits).toEqual([1]);
    expect(entries).toContainEqual({
      level: 'error',
      msg: 'upstream_unavailable',
      ctx: { reason: 'network' },
    });
    await app.close();
    stalled.closeAllConnections();
    stalled.close();
  });
});

describe('повтор сверки (спека 002, REQ-002-13)', () => {
  it('проверка повторяется раз в 1 с до истечения таймаута', async () => {
    const calls: number[] = [];
    const core = makeCore('http://127.0.0.1:1', recordingLog().log);
    const fakeCore = {
      ...core,
      checkUpstream: async () => {
        calls.push(performance.now());
        return { ok: false as const, missing: ['chat-large'] };
      },
    };

    const result = await waitForUpstream(fakeCore, { timeoutMs: 2100 });

    expect(result).toEqual({ ok: false, missing: ['chat-large'] });
    expect(calls.length).toBeGreaterThanOrEqual(3);
    expect(calls[1]! - calls[0]!).toBeGreaterThanOrEqual(900);
  });

  it('REQ-002-13: первая сверка missing, вторая ok → до второй порт не слушается, после — слушает', async () => {
    const fake = await startFakeProvider({ port: 0 });
    const { log } = recordingLog();
    const exits: number[] = [];
    const core = makeCore(fake.url, log);
    const app = await buildApp(core, gatewayOptions);
    let calls = 0;
    let listeningBeforeRetry: boolean | undefined;
    const flaky = {
      ...core,
      checkUpstream: (signal: AbortSignal) => {
        calls += 1;
        if (calls === 1) return Promise.resolve({ ok: false as const, missing: ['chat-large'] });
        listeningBeforeRetry = app.server.listening;
        return core.checkUpstream(signal);
      },
    };

    const listening = await startGateway({
      core: flaky,
      app,
      port: 0,
      host: '127.0.0.1',
      startupTimeoutMs: 5000,
      log,
      exit: (code) => void exits.push(code),
    });

    expect(calls).toBe(2);
    expect(listeningBeforeRetry).toBe(false);
    expect(listening).toBe(true);
    expect(app.server.listening).toBe(true);
    expect(exits).toEqual([]);
    await app.close();
    await fake.close();
  });
});

describe('секреты адаптера и каталог (спека 002, 4.9)', () => {
  it('upstreamSecrets: мастер-ключ и значения *_API_KEY, пустые и прочие переменные не входят', () => {
    const secrets = upstreamSecrets(
      {
        FAKE_PROVIDER_API_KEY: 'fake-provider-key-not-secret',
        OPENROUTER_API_KEY: '',
        LLM_GATEWAY_PORT: '3002',
      },
      MASTER_KEY,
    );

    expect(secrets).toEqual([MASTER_KEY, 'fake-provider-key-not-secret']);
  });

  it('readCatalog: разбирает каталог по ModelCatalog в порядке файла', () => {
    expect(readCatalog(catalogPath).models.map((model) => model.id)).toEqual([
      'chat-small',
      'chat-large',
    ]);
  });

  it('readCatalog: битый JSON → ошибка с путём файла, причина в cause', () => {
    const error = thrownBy(() => readCatalog(fixture('catalog-broken.json')));

    expect(error.message).toContain(fixture('catalog-broken.json'));
    expect(error.cause).toBeInstanceOf(SyntaxError);
  });

  it('readCatalog: нарушение схемы ModelCatalog → ошибка с путём файла, причина в cause', () => {
    const error = thrownBy(() => readCatalog(fixture('catalog-invalid.json')));

    expect(error.message).toContain(fixture('catalog-invalid.json'));
    expect(error.cause).toBeInstanceOf(Error);
  });
});
