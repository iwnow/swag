import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startFakeProvider } from '../../../infra/llm/fake-provider/server.ts';

type Fake = Awaited<ReturnType<typeof startFakeProvider>>;

let fake: Fake;

beforeEach(async () => {
  fake = await startFakeProvider({ port: 0 });
});

afterEach(async () => {
  await fake.close();
});

const chatBody = (content: unknown, extra: Record<string, unknown> = {}) => ({
  model: 'fake-small',
  messages: [{ role: 'user', content }],
  ...extra,
});

const streamBody = (content: unknown, extra: Record<string, unknown> = {}) =>
  chatBody(content, { stream: true, ...extra });

const post = (
  body: unknown,
  opts: { headers?: Record<string, string>; signal?: AbortSignal } = {},
) =>
  fetch(`${fake.url}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...opts.headers },
    body: JSON.stringify(body),
    signal: opts.signal ?? null,
  });

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Опрос с ограничением по времени: без бесконечного цикла.
async function waitFor(check: () => boolean, timeoutMs = 1000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`условие не выполнилось за ${String(timeoutMs)} мс`);
    await sleep(10);
  }
}

// Полезные нагрузки SSE-кадров без `data: ` и разделителей; [DONE] остаётся строкой.
const sseFrames = (text: string): string[] =>
  text
    .split('\n\n')
    .filter((frame) => frame !== '')
    .map((frame) => frame.replace(/^data: /, ''));

const chunksOf = (text: string) =>
  sseFrames(text)
    .filter((frame) => frame !== '[DONE]')
    .map((frame) => JSON.parse(frame) as Record<string, unknown>);

// Читает поток до конца; onText вызывается после каждого куска. Обрыв не бросает, а возвращается в error.
async function readStream(
  res: Response,
  onText?: (text: string) => void,
): Promise<{ text: string; error?: unknown }> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let text = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
      onText?.(text);
    }
    return { text };
  } catch (error: unknown) {
    return { text, error };
  }
}

describe('фейковый провайдер, без потока (спека 002, 4.12)', () => {
  it('без маркера отдаёт chat.completion с usage и cost и записывает запрос', async () => {
    const body = chatBody('привет');
    const res = await post(body, { headers: { authorization: 'Bearer test-token' } });

    expect(res.status).toBe(200);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json).toMatchObject({
      object: 'chat.completion',
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: 'fake reply' },
          finish_reason: 'stop',
        },
      ],
      usage: {
        prompt_tokens: 1000,
        completion_tokens: 500,
        total_tokens: 1500,
        prompt_tokens_details: { cached_tokens: 200 },
        cost: 0.0085,
      },
    });
    expect(fake.requests).toEqual([
      {
        path: '/v1/chat/completions',
        headers: expect.objectContaining({ authorization: 'Bearer test-token' }),
        body,
        closedByClient: false,
      },
    ]);
  });

  it('при tools возвращает tool_calls с первым инструментом и аргументами {}', async () => {
    const res = await post(
      chatBody('вызови', {
        tools: [
          { type: 'function', function: { name: 'lookup', parameters: { type: 'object' } } },
          { type: 'function', function: { name: 'other', parameters: { type: 'object' } } },
        ],
      }),
    );

    const json = (await res.json()) as {
      choices: { message: unknown; finish_reason: string }[];
    };
    expect(json.choices[0]).toEqual({
      index: 0,
      message: {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: expect.any(String),
            type: 'function',
            function: { name: 'lookup', arguments: '{}' },
          },
        ],
      },
      finish_reason: 'tool_calls',
    });
  });

  it('ищет маркер только в последнем сообщении, текст из частей content тоже учитывается', async () => {
    const earlier = await post({
      model: 'fake-small',
      messages: [
        { role: 'user', content: '__fail_500__' },
        { role: 'user', content: 'обычный вопрос' },
      ],
    });
    expect(earlier.status).toBe(200);

    const parts = await post(chatBody([{ type: 'text', text: '__no_cost__' }]));
    const json = (await parts.json()) as { usage: Record<string, unknown> };
    expect(json.usage).not.toHaveProperty('cost');
  });

  it('__no_usage__ — ответ без usage', async () => {
    const res = await post(chatBody('__no_usage__'));
    expect(res.status).toBe(200);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json).not.toHaveProperty('usage');
    expect(json).toHaveProperty('choices');
  });

  it('__no_cost__ — usage как по умолчанию, но без cost', async () => {
    const res = await post(chatBody('__no_cost__'));
    expect(res.status).toBe(200);
    const json = (await res.json()) as { usage: Record<string, unknown> };
    expect(json.usage).toEqual({
      prompt_tokens: 1000,
      completion_tokens: 500,
      total_tokens: 1500,
      prompt_tokens_details: { cached_tokens: 200 },
    });
  });

  it('__fail_500__ — 500 с error.message boom', async () => {
    const res = await post(chatBody('__fail_500__'));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: { message: 'boom' } });
  });

  it('__fail_429__ — 429 с error.message slow down', async () => {
    const res = await post(chatBody('__fail_429__'));
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ error: { message: 'slow down' } });
  });

  it('__fail_400__ — 400, сообщение содержит значение заголовка Authorization', async () => {
    const res = await post(chatBody('__fail_400__'), {
      headers: { authorization: 'Bearer fake-key-x' },
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: { message: 'bad request, auth was: Bearer fake-key-x' },
    });
  });

  it('GET /v1/models по умолчанию отдаёт chat-small и chat-large', async () => {
    const res = await fetch(`${fake.url}/v1/models`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      object: 'list',
      data: [{ id: 'chat-small' }, { id: 'chat-large' }],
    });
  });

  it('GET /v1/models берёт список из opts.models', async () => {
    const custom = await startFakeProvider({ port: 0, models: ['only-one'] });
    try {
      const res = await fetch(`${custom.url}/v1/models`);
      expect(await res.json()).toEqual({ object: 'list', data: [{ id: 'only-one' }] });
    } finally {
      await custom.close();
    }
  });

  it('в requests попадает только POST /v1/chat/completions: GET /v1/models не записывается', async () => {
    await fetch(`${fake.url}/v1/models`);
    await post(chatBody('привет'));

    expect(fake.requests).toHaveLength(1);
    expect(fake.requests[0]?.path).toBe('/v1/chat/completions');
  });

  it('неизвестный путь — 404 и не попадает в requests', async () => {
    const res = await fetch(`${fake.url}/v1/unknown`);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: { message: 'not found' } });
    expect(fake.requests).toHaveLength(0);
  });
});

describe('фейковый провайдер, поток (спека 002, 4.12)', () => {
  it('поток по умолчанию: два текстовых фрагмента, без usage, затем [DONE]', async () => {
    const res = await post(streamBody('привет'));

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/event-stream');
    const text = await res.text();
    expect(sseFrames(text).at(-1)).toBe('[DONE]');

    const chunks = chunksOf(text);
    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toMatchObject({
      id: 'chatcmpl-fake',
      object: 'chat.completion.chunk',
      model: 'fake-small',
      choices: [{ index: 0, delta: { role: 'assistant', content: 'fake' }, finish_reason: null }],
    });
    expect(chunks[1]).toMatchObject({
      choices: [{ index: 0, delta: { content: ' reply' }, finish_reason: 'stop' }],
    });
    expect(chunks.some((chunk) => 'usage' in chunk)).toBe(false);
    expect(fake.requests[0]?.closedByClient).toBe(false);
  });

  it('stream_options.include_usage: после текста фрагмент с choices [] и usage, затем [DONE]', async () => {
    const res = await post(streamBody('привет', { stream_options: { include_usage: true } }));

    const text = await res.text();
    expect(sseFrames(text).at(-1)).toBe('[DONE]');
    const chunks = chunksOf(text);
    expect(chunks).toHaveLength(3);
    expect(chunks[2]).toMatchObject({
      object: 'chat.completion.chunk',
      choices: [],
      usage: {
        prompt_tokens: 1000,
        completion_tokens: 500,
        total_tokens: 1500,
        prompt_tokens_details: { cached_tokens: 200 },
        cost: 0.0085,
      },
    });
  });

  it('include_usage с __no_usage__ — фрагмента usage нет; с __no_cost__ — usage без cost', async () => {
    const noUsage = await post(
      streamBody('__no_usage__', { stream_options: { include_usage: true } }),
    );
    expect(chunksOf(await noUsage.text())).toHaveLength(2);

    const noCost = await post(
      streamBody('__no_cost__', { stream_options: { include_usage: true } }),
    );
    const usageChunk = chunksOf(await noCost.text())[2] as { usage: Record<string, unknown> };
    expect(usageChunk.usage).not.toHaveProperty('cost');
  });

  it('FAKE_CHUNK_DELAY_MS задаёт паузу между фрагментами потока', async () => {
    process.env.FAKE_CHUNK_DELAY_MS = '50';
    try {
      const started = Date.now();
      const res = await post(streamBody('привет'));
      await res.text();
      // Три события (два фрагмента и [DONE]) — две паузы по 50 мс.
      expect(Date.now() - started).toBeGreaterThanOrEqual(90);
    } finally {
      delete process.env.FAKE_CHUNK_DELAY_MS;
    }
  });

  it('__slow_chunks__: первый фрагмент приходит сразу, весь поток — не раньше 500 мс', async () => {
    const started = Date.now();
    let firstAt: number | undefined;
    const res = await post(streamBody('__slow_chunks__'));
    const { text } = await readStream(res, (soFar) => {
      if (firstAt === undefined && soFar.includes('"content":"fake"'))
        firstAt = Date.now() - started;
    });

    expect(firstAt).toBeLessThan(300);
    expect(Date.now() - started).toBeGreaterThanOrEqual(500);
    expect(sseFrames(text).at(-1)).toBe('[DONE]');
  });

  it('__cut__: первый фрагмент, затем обрыв без [DONE]', async () => {
    const res = await post(streamBody('__cut__'));
    const { text, error } = await readStream(res);

    expect(text).toContain('"content":"fake"');
    expect(text).not.toContain('reply');
    expect(text).not.toContain('[DONE]');
    expect(error).toBeDefined();
    // Обрыв сделал фейк, клиент не закрывал соединение.
    expect(fake.requests[0]?.closedByClient).toBe(false);
  });

  it('__hang__: заголовки не приходят, пока клиент не закроет соединение', async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 200);
    const error: unknown = await post(chatBody('__hang__'), {
      signal: controller.signal,
    }).catch((reason: unknown) => reason);
    clearTimeout(timer);

    expect((error as Error).name).toBe('AbortError');
    await waitFor(() => fake.requests[0]?.closedByClient === true);
  });

  it('closedByClient: клиент рвёт поток после первого фрагмента — фейк видит закрытие', async () => {
    const controller = new AbortController();
    const res = await post(streamBody('__slow_chunks__'), { signal: controller.signal });
    const { text } = await readStream(res, (soFar) => {
      if (soFar.includes('"content":"fake"')) controller.abort();
    });

    expect(text).toContain('"content":"fake"');
    await waitFor(() => fake.requests[0]?.closedByClient === true);
  });
});
