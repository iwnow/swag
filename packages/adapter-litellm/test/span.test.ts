import { describe, expect, it } from 'vitest';
import { SpanKind, SpanStatusCode } from '@opentelemetry/api';
import { createMemoryExporters, startTelemetry } from '@swag/adapter-telemetry';
import type { UpstreamStream } from '@swag/llm-gateway-core';
import { chatRequest, signal, upstreamFor, useFake } from './helpers.ts';

// Спека 002, 4.5: спан litellm.chat. Тесты без AC-id: спан не закрывает AC, он нужен для REQ-002-14 на уровне адаптера.

const fake = useFake();

const streamBody = (content: string) => ({
  ...chatRequest(content),
  stream: true,
  stream_options: { include_usage: true },
});

// Спаны litellm.chat, записанные за время run; после shutdown память сохраняет записи.
async function chatSpans(run: () => Promise<unknown>) {
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
    await run();
  } finally {
    await telemetry.shutdown();
  }
  return memory.finishedSpans.filter((span) => span.name === 'litellm.chat');
}

// Текст сообщений запроса и ответа не попадает ни в один атрибут.
function expectNoText(attributes: Record<string, unknown>) {
  const dump = JSON.stringify(attributes);
  expect(dump).not.toContain('привет');
  expect(dump).not.toContain('reply');
}

describe('спан litellm.chat (спека 002, 4.5)', () => {
  it('complete: клиентский спан с моделью, потоком, статусом и usage, без текста', async () => {
    const spans = await chatSpans(() =>
      upstreamFor(fake.current.url).complete(chatRequest('привет'), signal()),
    );

    expect(spans).toHaveLength(1);
    const [span] = spans;
    expect(span?.kind).toBe(SpanKind.CLIENT);
    expect(span?.status.code).toBe(SpanStatusCode.UNSET);
    expect(span?.attributes).toEqual({
      'gen_ai.request.model': 'fake-small',
      'swag.llm.stream': false,
      'http.response.status_code': 200,
      'gen_ai.usage.input_tokens': 1000,
      'gen_ai.usage.output_tokens': 500,
    });
    expectNoText(span?.attributes ?? {});
  });

  it('complete без usage в ответе: атрибутов gen_ai.usage.* нет', async () => {
    const spans = await chatSpans(() =>
      upstreamFor(fake.current.url).complete(chatRequest('__no_usage__'), signal()),
    );

    expect(spans[0]?.attributes).toEqual({
      'gen_ai.request.model': 'fake-small',
      'swag.llm.stream': false,
      'http.response.status_code': 200,
    });
  });

  it('stream: спан заканчивается по концу потока, usage берётся из фрагмента usage, текст не попадает', async () => {
    const spans = await chatSpans(async () => {
      const result: UpstreamStream = await upstreamFor(fake.current.url).stream(
        streamBody('привет'),
        signal(),
      );
      if (!result.ok) throw new Error(JSON.stringify(result.failure));
      for await (const _payload of result.chunks);
    });

    expect(spans).toHaveLength(1);
    const [span] = spans;
    expect(span?.kind).toBe(SpanKind.CLIENT);
    expect(span?.status.code).toBe(SpanStatusCode.UNSET);
    expect(span?.attributes).toEqual({
      'gen_ai.request.model': 'fake-small',
      'swag.llm.stream': true,
      'http.response.status_code': 200,
      'gen_ai.usage.input_tokens': 1000,
      'gen_ai.usage.output_tokens': 500,
    });
    expectNoText(span?.attributes ?? {});
  });

  it('stream: раннее закрытие потребителем тоже заканчивает спан', async () => {
    const spans = await chatSpans(async () => {
      const result: UpstreamStream = await upstreamFor(fake.current.url).stream(
        streamBody('привет'),
        signal(),
      );
      if (!result.ok) throw new Error(JSON.stringify(result.failure));
      for await (const _payload of result.chunks) break;
    });

    expect(spans).toHaveLength(1);
    expect(spans[0]?.status.code).toBe(SpanStatusCode.UNSET);
    expect(spans[0]?.attributes).not.toHaveProperty('gen_ai.usage.input_tokens');
  });

  it('статус ответа 500 — http.response.status_code и статус ошибки спана', async () => {
    const spans = await chatSpans(() =>
      upstreamFor(fake.current.url).complete(chatRequest('__fail_500__'), signal()),
    );

    expect(spans[0]?.status.code).toBe(SpanStatusCode.ERROR);
    expect(spans[0]?.attributes).toEqual({
      'gen_ai.request.model': 'fake-small',
      'swag.llm.stream': false,
      'http.response.status_code': 500,
    });
  });

  it('сеть недоступна — нет http.response.status_code, статус ошибки спана', async () => {
    const spans = await chatSpans(() =>
      upstreamFor(fake.current.url, {
        fetch: (async () => {
          throw new TypeError('fetch failed');
        }) as typeof fetch,
      }).complete(chatRequest('привет'), signal()),
    );

    expect(spans[0]?.status.code).toBe(SpanStatusCode.ERROR);
    expect(spans[0]?.attributes).not.toHaveProperty('http.response.status_code');
    expect(spans[0]?.attributes).toEqual({
      'gen_ai.request.model': 'fake-small',
      'swag.llm.stream': false,
    });
  });

  it('stream с не-2xx до потока — спан закрыт сразу и помечен ошибкой', async () => {
    const spans = await chatSpans(() =>
      upstreamFor(fake.current.url).stream(streamBody('__fail_500__'), signal()),
    );

    expect(spans).toHaveLength(1);
    expect(spans[0]?.status.code).toBe(SpanStatusCode.ERROR);
    expect(spans[0]?.attributes).toEqual({
      'gen_ai.request.model': 'fake-small',
      'swag.llm.stream': true,
      'http.response.status_code': 500,
    });
  });
});
