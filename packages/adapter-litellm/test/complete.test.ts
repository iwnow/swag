import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createMemoryExporters, startTelemetry } from '@swag/adapter-telemetry';
import type { ChatRequest } from '@swag/llm-gateway-core';
import { startFakeProvider } from '../../../infra/llm/fake-provider/server.ts';
import { createLiteLlmUpstream, redact } from '../src/index.ts';

// Значения из 4.9 спеки: мастер-ключ LiteLLM и ключ фейка (`*_API_KEY`).
const MASTER_KEY = 'sk-swag-local-not-secret';
const FAKE_KEY = 'fake-provider-key-not-secret';

type Fake = Awaited<ReturnType<typeof startFakeProvider>>;

let fake: Fake;

beforeEach(async () => {
  fake = await startFakeProvider({ port: 0 });
});

afterEach(async () => {
  await fake.close();
});

const request = (content: string): ChatRequest => ({
  model: 'fake-small',
  messages: [{ role: 'user', content }],
});

const upstreamFor = (url: string) =>
  createLiteLlmUpstream({
    baseUrl: url,
    masterKey: MASTER_KEY,
    idleTimeoutMs: 120_000,
    secrets: [MASTER_KEY, FAKE_KEY],
  });

const signal = () => new AbortController().signal;

describe('redact (спека 002, 4.5)', () => {
  it('AC-002-17: пустой секрет не меняет текст', () => {
    expect(redact('без секретов', ['', ''])).toBe('без секретов');
    expect(redact('a-b', ['', 'b'])).toBe('a-***');
  });

  it('AC-002-17: заменяет все вхождения каждого секрета на ***', () => {
    expect(redact(`${MASTER_KEY} и снова ${MASTER_KEY}`, [MASTER_KEY])).toBe('*** и снова ***');
  });
});

describe('complete (спека 002, 4.5, без таймаута)', () => {
  it('обычный ответ 2xx — body как пришёл, запрос с Authorization мастер-ключа', async () => {
    const upstream = upstreamFor(fake.url);
    const body = request('привет');

    const result = await upstream.complete(body, signal());

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.body).toMatchObject({
      object: 'chat.completion',
      choices: [{ message: { content: 'fake reply' } }],
    });
    const sent = fake.requests[0];
    expect(sent?.path).toBe('/v1/chat/completions');
    expect(sent?.headers['authorization']).toBe(`Bearer ${MASTER_KEY}`);
    expect(sent?.headers['content-type']).toBe('application/json');
    expect(sent?.body).toEqual(body);
  });

  it('AC-002-17: __fail_400__ — message без ключа фейка и мастер-ключа, с ***', async () => {
    const upstream = upstreamFor(fake.url);

    const result = await upstream.complete(request('__fail_400__'), signal());

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure).toEqual({
      kind: 'http',
      status: 400,
      message: 'bad request, auth was: Bearer ***',
    });
    expect(result.failure.kind === 'http' && result.failure.message).not.toContain(MASTER_KEY);
    expect(result.failure.kind === 'http' && result.failure.message).not.toContain(FAKE_KEY);
  });

  it('__fail_500__ — message из error.message', async () => {
    const result = await upstreamFor(fake.url).complete(request('__fail_500__'), signal());

    expect(result).toEqual({ ok: false, failure: { kind: 'http', status: 500, message: 'boom' } });
  });

  it('__fail_429__ — message из error.message', async () => {
    const result = await upstreamFor(fake.url).complete(request('__fail_429__'), signal());

    expect(result).toEqual({
      ok: false,
      failure: { kind: 'http', status: 429, message: 'slow down' },
    });
  });

  it('недоступный порт — network', async () => {
    const closed = await startFakeProvider({ port: 0 });
    const url = closed.url;
    await closed.close();

    const result = await upstreamFor(url).complete(request('привет'), signal());

    expect(result).toEqual({ ok: false, failure: { kind: 'network' } });
  });

  it('traceparent из активного спана уходит в заголовке запроса', async () => {
    const memory = createMemoryExporters();
    const telemetry = startTelemetry({
      service: 'llm-gateway',
      version: '0.0.0',
      otlpEndpoint: null,
      logLevel: 'error',
      flushTimeoutMs: 1000,
      stdout: () => {},
      exporters: { spans: memory.spans },
    });
    try {
      const upstream = upstreamFor(fake.url);
      let expected: string | null = null;

      await telemetry.inSpan('test.complete', { kind: 'client' }, () => {
        expected = telemetry.currentTraceparent();
        return upstream.complete(request('привет'), signal());
      });

      expect(expected).not.toBeNull();
      expect(fake.requests[0]?.headers['traceparent']).toBe(expected);
    } finally {
      await telemetry.shutdown();
    }
  });
});
