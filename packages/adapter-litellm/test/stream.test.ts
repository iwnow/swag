import { describe, expect, it, vi } from 'vitest';
import { UpstreamStreamError, type UpstreamStream } from '@swag/llm-gateway-core';
import { sseData } from '../src/index.ts';
import { chatRequest, signal, stubFetch, upstreamFor, useFake } from './helpers.ts';

// Спека 002, 4.4 и 4.5: поток адаптера против фейка. Тесты без AC-id: REQ-002-10 (поток) на уровне адаптера;
// AC-002-10…13 описывают ответ шлюза и закрываются в T-17…T-23.

const fake = useFake();

const streamBody = (content: string) => ({ ...chatRequest(content), stream: true });

const json = (payload: string | undefined): unknown => JSON.parse(String(payload));

async function* parts(...items: string[]): AsyncGenerator<string> {
  for (const item of items) yield item;
}

async function collect(chunks: AsyncIterable<string>): Promise<string[]> {
  const out: string[] = [];
  for await (const chunk of chunks) out.push(chunk);
  return out;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Отказ до первого фрагмента — тест падает с понятным текстом, а не с TypeError.
async function open(
  baseUrl: string,
  content: string,
  overrides: Parameters<typeof upstreamFor>[1] = {},
  abort: AbortSignal = signal(),
): Promise<AsyncIterable<string>> {
  const result: UpstreamStream = await upstreamFor(baseUrl, overrides).stream(
    streamBody(content),
    abort,
  );
  if (!result.ok) throw new Error(JSON.stringify(result.failure));
  return result.chunks;
}

describe('stream: поток по умолчанию (спека 002, 4.5, REQ-002-10)', () => {
  it('без include_usage: два фрагмента и [DONE] отдаются как payload без префикса data:', async () => {
    const chunks = await open(fake.current.url, 'привет');

    const payloads = await collect(chunks);

    expect(payloads).toHaveLength(3);
    expect(payloads.at(-1)).toBe('[DONE]');
    expect(json(payloads[0])).toMatchObject({
      object: 'chat.completion.chunk',
      choices: [{ delta: { content: 'fake' } }],
    });
    expect(json(payloads[1])).toMatchObject({ choices: [{ delta: { content: ' reply' } }] });
  });

  it('с stream_options.include_usage: добавляется кадр usage перед [DONE]', async () => {
    const body = { ...streamBody('привет'), stream_options: { include_usage: true } };
    const result = await upstreamFor(fake.current.url).stream(body, signal());
    if (!result.ok) throw new Error(JSON.stringify(result.failure));

    const payloads = await collect(result.chunks);

    expect(payloads).toHaveLength(4);
    expect(json(payloads[2])).toMatchObject({ choices: [], usage: { prompt_tokens: 1000 } });
    expect(payloads.at(-1)).toBe('[DONE]');
    expect(fake.current.requests.at(-1)?.body).toMatchObject({
      stream_options: { include_usage: true },
    });
  });
});

describe('stream: многобайтный UTF-8 на границе кусков (спека 002, 4.5)', () => {
  const bodyOf = (...parts: Uint8Array[]) =>
    new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          for (const part of parts) controller.enqueue(part);
          controller.close();
        },
      }),
      { headers: { 'content-type': 'text/event-stream' } },
    );

  it.each(['я', '€'])(
    'символ «%s», разрезанный между двумя кусками тела, собирается целиком',
    async (char) => {
      const encoder = new TextEncoder();
      const bytes = encoder.encode(`data: {"c":"${char}"}\n\ndata: [DONE]\n\n`);
      const cut = encoder.encode('data: {"c":"').length + 1;
      const chunks = await open('http://stub.invalid', 'привет', {
        fetch: stubFetch(bodyOf(bytes.slice(0, cut), bytes.slice(cut))),
      });

      expect(await collect(chunks)).toEqual([`{"c":"${char}"}`, '[DONE]']);
    },
  );
});

describe('stream: обрывы и таймаут (спека 002, 4.5)', () => {
  it('__cut__: фрагмент, затем обрыв без [DONE] — UpstreamStreamError network', async () => {
    const chunks = await open(fake.current.url, '__cut__');

    const seen: string[] = [];
    const reading = (async () => {
      for await (const chunk of chunks) seen.push(chunk);
    })();

    await expect(reading).rejects.toBeInstanceOf(UpstreamStreamError);
    await expect(reading).rejects.toMatchObject({ failure: { kind: 'network' } });
    expect(seen).toHaveLength(1);
    expect(json(seen[0])).toMatchObject({ choices: [{ delta: { content: 'fake' } }] });
  });

  it('тело закончилось без [DONE] — UpstreamStreamError network', async () => {
    const body = new Response('data: {"a":1}\n\n', {
      headers: { 'content-type': 'text/event-stream' },
    });
    const chunks = await open('http://stub.invalid', 'привет', { fetch: stubFetch(body) });

    await expect(collect(chunks)).rejects.toMatchObject({ failure: { kind: 'network' } });
  });

  it('__slow_chunks__ при idleTimeoutMs 200 — первый фрагмент, затем timeout', async () => {
    const chunks = await open(fake.current.url, '__slow_chunks__', { idleTimeoutMs: 200 });
    const started = performance.now();

    const seen: string[] = [];
    const reading = (async () => {
      for await (const chunk of chunks) seen.push(chunk);
    })();

    await expect(reading).rejects.toMatchObject({ failure: { kind: 'timeout' } });
    expect(seen).toHaveLength(1);
    expect(performance.now() - started).toBeLessThan(1000);
    await vi.waitFor(() => expect(fake.current.requests[0]?.closedByClient).toBe(true));
  });

  it('пауза потребителя дольше idleTimeoutMs не простой: все payload до [DONE] приходят', async () => {
    const chunks = await open(fake.current.url, 'привет', { idleTimeoutMs: 100 });

    const payloads: string[] = [];
    await sleep(300);
    for await (const chunk of chunks) {
      payloads.push(chunk);
      await sleep(300);
    }

    expect(payloads).toHaveLength(3);
    expect(payloads.at(-1)).toBe('[DONE]');
  });

  it('внешний abort после первого фрагмента — UpstreamStreamError aborted', async () => {
    const controller = new AbortController();
    const chunks = await open(fake.current.url, '__slow_chunks__', {}, controller.signal);
    const iterator = chunks[Symbol.asyncIterator]();
    await iterator.next();

    controller.abort();

    const failed = await iterator.next().catch((error: unknown) => error);
    expect(failed).toBeInstanceOf(UpstreamStreamError);
    expect(failed).toMatchObject({ failure: { kind: 'aborted' } });
  });

  it('ранний выход потребителя (break) закрывает соединение с фейком', async () => {
    const chunks = await open(fake.current.url, '__slow_chunks__');

    for await (const chunk of chunks) {
      expect(chunk).toContain('fake');
      break;
    }

    await vi.waitFor(() => expect(fake.current.requests[0]?.closedByClient).toBe(true));
  });
});

describe('stream: отказ до потока (спека 002, 4.5)', () => {
  it('не-2xx — ok: false с http, как у complete', async () => {
    const result = await upstreamFor(fake.current.url).stream(streamBody('__fail_500__'), signal());

    expect(result).toEqual({ ok: false, failure: { kind: 'http', status: 500, message: 'boom' } });
  });

  it('уже прерванный внешний signal — ok: false с network', async () => {
    const controller = new AbortController();
    controller.abort();

    const result = await upstreamFor(fake.current.url).stream(
      streamBody('привет'),
      controller.signal,
    );

    expect(result).toEqual({ ok: false, failure: { kind: 'network' } });
  });
});

describe('sseData: разбор SSE (спека 002, 4.5)', () => {
  it('строки data: одного события склеиваются через \\n, один ведущий пробел убирается', async () => {
    const payloads = await collect(sseData(parts('data: {"a":\ndata:  1}\n\n')));

    expect(payloads).toEqual(['{"a":\n 1}']);
  });

  it('комментарии `:` и другие поля (event, id, retry) пропускаются', async () => {
    const payloads = await collect(
      sseData(parts(': keep-alive\n\nevent: message\nid: 7\nretry: 100\ndata: x\n: comment\n\n')),
    );

    expect(payloads).toEqual(['x']);
  });

  it('событие без data-строк не отдаётся; [DONE] отдаётся как обычный payload', async () => {
    const payloads = await collect(sseData(parts('event: ping\n\ndata: a\n\ndata: [DONE]\n\n')));

    expect(payloads).toEqual(['a', '[DONE]']);
  });

  it('событие, разрезанное между кусками, и \\r\\n собираются правильно', async () => {
    const payloads = await collect(
      sseData(parts('data: hel', 'lo\r\n', '\r', '\ndata: w', 'orld\n\n')),
    );

    expect(payloads).toEqual(['hello', 'world']);
  });
});
