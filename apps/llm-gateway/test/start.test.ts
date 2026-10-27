import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.ts';
import { startGateway, upstreamSecrets, waitForUpstream } from '../src/start.ts';
import { startFakeProvider } from '../../../infra/llm/fake-provider/server.ts';
import { MASTER_KEY, catalogPath, makeCore, recordingLog } from './support.ts';
import { readCatalog } from '../src/catalog.ts';

// Спека 002, 4.2 (/health), 4.9, REQ-002-13: старт со сверкой каталога с апстримом.

describe('старт шлюза против фейка (спека 002, REQ-002-13)', () => {
  it('AC-002-18: в апстриме нет chat-large → порт не слушается, error upstream_models_mismatch, выход с кодом 1', async () => {
    const fake = await startFakeProvider({ port: 0, models: ['chat-small'] });
    const { log, entries } = recordingLog();
    const exits: number[] = [];
    const app = await buildApp(makeCore(fake.url, log));

    const started = performance.now();
    const listening = await startGateway({
      core: makeCore(fake.url, log),
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
    const app = await buildApp(makeCore(fake.url, log));

    const listening = await startGateway({
      core: makeCore(fake.url, log),
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
});
