import { describe, expect, it } from 'vitest';
import { createMemoryExporters, startTelemetry } from '@swag/adapter-telemetry';
import { startFakeProvider } from '../../../infra/llm/fake-provider/server.ts';
import { redact } from '../src/index.ts';
import {
  MASTER_KEY,
  FAKE_KEY,
  STUB_URL,
  chatRequest,
  signal,
  stubFetch,
  upstreamFor,
  useFake,
} from './helpers.ts';

const fake = useFake();

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
    const upstream = upstreamFor(fake.current.url);
    const body = chatRequest('привет');

    const result = await upstream.complete(body, signal());

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.body).toMatchObject({
      object: 'chat.completion',
      choices: [{ message: { content: 'fake reply' } }],
    });
    const sent = fake.current.requests[0];
    expect(sent?.path).toBe('/v1/chat/completions');
    expect(sent?.headers['authorization']).toBe(`Bearer ${MASTER_KEY}`);
    expect(sent?.headers['content-type']).toBe('application/json');
    expect(sent?.body).toEqual(body);
  });

  it('AC-002-17: __fail_400__ — message без ключа фейка и мастер-ключа, с ***', async () => {
    const upstream = upstreamFor(fake.current.url);

    const result = await upstream.complete(chatRequest('__fail_400__'), signal());

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
    const result = await upstreamFor(fake.current.url).complete(
      chatRequest('__fail_500__'),
      signal(),
    );

    expect(result).toEqual({ ok: false, failure: { kind: 'http', status: 500, message: 'boom' } });
  });

  it('__fail_429__ — message из error.message', async () => {
    const result = await upstreamFor(fake.current.url).complete(
      chatRequest('__fail_429__'),
      signal(),
    );

    expect(result).toEqual({
      ok: false,
      failure: { kind: 'http', status: 429, message: 'slow down' },
    });
  });

  it('недоступный порт — network', async () => {
    const closed = await startFakeProvider({ port: 0 });
    const url = closed.url;
    await closed.close();

    const result = await upstreamFor(url).complete(chatRequest('привет'), signal());

    expect(result).toEqual({ ok: false, failure: { kind: 'network' } });
  });

  it('traceparent несёт контекст спана litellm.chat, он дочерний к спану вызывающего', async () => {
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
      const upstream = upstreamFor(fake.current.url);

      await telemetry.inSpan('test.complete', { kind: 'client' }, () =>
        upstream.complete(chatRequest('привет'), signal()),
      );
    } finally {
      await telemetry.shutdown();
    }

    const outer = memory.finishedSpans.find((span) => span.name === 'test.complete');
    const chat = memory.finishedSpans.find((span) => span.name === 'litellm.chat');
    expect(chat?.parentSpanContext?.spanId).toBe(outer?.spanContext().spanId);
    const { traceId, spanId } = chat?.spanContext() ?? { traceId: '', spanId: '' };
    expect(fake.current.requests[0]?.headers['traceparent']).toBe(`00-${traceId}-${spanId}-01`);
  });
});

describe('complete: ответы, которые фейк не даёт (D-49, D-48)', () => {
  it('D-49: 2xx с телом, которое не читается как JSON — network', async () => {
    const result = await upstreamFor(STUB_URL, {
      fetch: stubFetch(new Response('не json', { status: 200 })),
    }).complete(chatRequest('привет'), signal());

    expect(result).toEqual({ ok: false, failure: { kind: 'network' } });
  });

  it('не-2xx без JSON-тела или без error.message — http с HTTP <status>', async () => {
    const bodies = ['<html>Bad Gateway</html>', '{"error":{}}'];

    for (const text of bodies) {
      const result = await upstreamFor(STUB_URL, {
        fetch: stubFetch(new Response(text, { status: 502 })),
      }).complete(chatRequest('привет'), signal());

      expect(result).toEqual({
        ok: false,
        failure: { kind: 'http', status: 502, message: 'HTTP 502' },
      });
    }
  });

  it('D-48: message обрезается до 1000 символов, затем redact — секрет в начале заменён на ***', async () => {
    const long = `${MASTER_KEY}${'x'.repeat(2000)}`;
    const result = await upstreamFor(STUB_URL, {
      fetch: stubFetch(new Response(JSON.stringify({ error: { message: long } }), { status: 400 })),
    }).complete(chatRequest('привет'), signal());

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure).toEqual({
      kind: 'http',
      status: 400,
      message: `***${'x'.repeat(1000 - MASTER_KEY.length)}`,
    });
  });
});
