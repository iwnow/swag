import { afterEach, describe, expect, it } from 'vitest';
import { caller, closeAll, listenUrl, openGateway } from './support.ts';

// Спека 002, 4.2 (SSE клиенту) и 4.6. Поток идёт по настоящей сети (listen на 127.0.0.1), не через inject:
// проверяется время первого фрагмента и обрыв соединения клиентом. Тесты AC-002-10 … -13, потоковая часть AC-002-15.

const headers = { ...caller, 'content-type': 'application/json' };

const streamBody = (text: string) => ({
  model: 'chat-small',
  max_tokens: 256,
  messages: [{ role: 'user', content: text }],
  stream: true,
});

afterEach(closeAll);

// Шлюз слушает порт; url — адрес маршрута чата.
async function openStreamGateway() {
  const gateway = await openGateway();
  return { ...gateway, url: `${await listenUrl(gateway.app)}/v1/chat/completions` };
}

// Кадры SSE: каждый кадр — `data: <payload>` и пустая строка.
function ssePayloads(text: string): string[] {
  return text
    .split('\n\n')
    .filter((frame) => frame !== '')
    .map((frame) => {
      if (!frame.startsWith('data: ')) throw new Error(`не SSE-кадр: ${frame}`);
      return frame.slice('data: '.length);
    });
}

const contentOf = (payload: string) =>
  (JSON.parse(payload) as { choices: { delta: { content: string } }[] }).choices[0]?.delta.content;

async function until(check: () => boolean, ms: number): Promise<void> {
  const deadline = performance.now() + ms;
  while (!check()) {
    if (performance.now() > deadline) throw new Error(`условие не выполнилось за ${ms} мс`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe('оболочка llm-gateway: поток SSE по сети (спека 002, 4.2, 4.6)', () => {
  it('AC-002-10: заголовки SSE, фрагменты, usage и [DONE] по порядку, фейк получил include_usage, событие ok', async () => {
    const gateway = await openStreamGateway();

    const response = await fetch(gateway.url, {
      method: 'POST',
      headers,
      body: JSON.stringify(streamBody('hi')),
    });
    const text = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    expect(response.headers.get('cache-control')).toBe('no-cache');
    const payloads = ssePayloads(text);
    expect(payloads).toHaveLength(4);
    expect(contentOf(payloads[0] ?? '')).toBe('fake');
    expect(contentOf(payloads[1] ?? '')).toBe(' reply');
    expect(JSON.parse(payloads[2] ?? '')).toMatchObject({
      usage: { prompt_tokens: 1000, completion_tokens: 500 },
    });
    expect(payloads[3]).toBe('[DONE]');
    expect(text.endsWith('data: [DONE]\n\n')).toBe(true);
    expect(gateway.fake.requests[0]?.body).toMatchObject({
      stream_options: { include_usage: true },
    });
    expect(gateway.events).toMatchObject([
      {
        type: 'llm.call',
        source: 'llm-gateway',
        data: {
          status: 'ok',
          stream: true,
          usage: { promptTokens: 1000, cachedPromptTokens: 200, completionTokens: 500 },
          costMicroUsd: 9960,
        },
      },
    ]);
  });

  it('AC-002-11: __slow_chunks__ — первый фрагмент раньше 300 мс от отправки, весь поток не раньше 500 мс', async () => {
    const gateway = await openStreamGateway();
    const started = performance.now();

    const response = await fetch(gateway.url, {
      method: 'POST',
      headers,
      body: JSON.stringify(streamBody('__slow_chunks__')),
    });
    const reader = response.body?.getReader();
    if (!reader) throw new Error('нет тела ответа');
    const decoder = new TextDecoder();
    let text = '';
    let firstAt: number | undefined;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
      if (firstAt === undefined && text.includes('data: ')) firstAt = performance.now() - started;
    }
    const total = performance.now() - started;

    expect(firstAt).toBeDefined();
    expect(firstAt ?? Infinity).toBeLessThan(300);
    expect(total).toBeGreaterThanOrEqual(500);
    expect(ssePayloads(text).at(-1)).toBe('[DONE]');
  });

  it('AC-002-12: __cut__ — первый фрагмент, затем {"error":...} с upstream_error, без [DONE]; событие aborted с errorCode', async () => {
    const gateway = await openStreamGateway();

    const response = await fetch(gateway.url, {
      method: 'POST',
      headers,
      body: JSON.stringify(streamBody('__cut__')),
    });
    const text = await response.text();

    const payloads = ssePayloads(text);
    expect(payloads).toHaveLength(2);
    expect(contentOf(payloads[0] ?? '')).toBe('fake');
    expect(JSON.parse(payloads[1] ?? '')).toEqual({
      error: { message: expect.any(String), type: 'swag_gateway_error', code: 'upstream_error' },
    });
    expect(text).not.toContain('[DONE]');
    expect(gateway.events).toMatchObject([
      {
        data: {
          status: 'aborted',
          stream: true,
          errorCode: 'upstream_error',
          usage: null,
          costMicroUsd: null,
        },
      },
    ]);
  });

  it('AC-002-13: клиент рвёт соединение после первого фрагмента — фейк видит закрытие за 1 с, событие aborted без errorCode; процесс жив', async () => {
    const gateway = await openStreamGateway();
    const controller = new AbortController();

    const response = await fetch(gateway.url, {
      method: 'POST',
      headers,
      body: JSON.stringify(streamBody('__slow_chunks__')),
      signal: controller.signal,
    });
    const reader = response.body?.getReader();
    if (!reader) throw new Error('нет тела ответа');
    const decoder = new TextDecoder();
    let text = '';
    while (!text.includes('data: ')) {
      const { value } = await reader.read();
      text += decoder.decode(value, { stream: true });
    }
    controller.abort();

    await until(() => gateway.fake.requests[0]?.closedByClient === true, 1000);
    await until(() => gateway.events.length === 1, 3000);
    expect(gateway.events).toMatchObject([{ data: { status: 'aborted', stream: true } }]);
    expect(gateway.events[0]?.data).not.toHaveProperty('errorCode');

    const next = await fetch(gateway.url, {
      method: 'POST',
      headers,
      body: JSON.stringify(streamBody('hi')),
    });
    expect(next.status).toBe(200);
    await next.text();
  });

  it('AC-002-15 потоком: отказ до первого фрагмента — обычный JSON-ответ с кодом по 4.6 и событие error', async () => {
    const gateway = await openStreamGateway();
    const cases = [
      { marker: '__fail_500__', status: 502, code: 'upstream_error', message: 'Upstream error' },
      { marker: '__fail_429__', status: 429, code: 'rate_limited', message: 'Provider rate limit' },
      { marker: '__fail_400__', status: 400, code: 'upstream_bad_request', message: 'bad request' },
    ];

    for (const { marker, status, code, message } of cases) {
      const response = await fetch(gateway.url, {
        method: 'POST',
        headers,
        body: JSON.stringify(streamBody(marker)),
      });
      const failure = (await response.json()) as {
        error: { type: string; message: string; code: string };
      };
      expect(response.status).toBe(status);
      expect(response.headers.get('content-type')).toContain('application/json');
      expect(failure.error).toMatchObject({ type: 'swag_gateway_error', code });
      expect(failure.error.message).toContain(message);
    }
    expect(gateway.events).toMatchObject([
      { data: { status: 'error', stream: true, errorCode: 'upstream_error' } },
      { data: { status: 'error', stream: true, errorCode: 'rate_limited' } },
      { data: { status: 'error', stream: true, errorCode: 'upstream_bad_request' } },
    ]);
  });
});
