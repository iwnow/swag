import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startFakeProvider } from '../../../infra/llm/fake-provider/server.ts';

type Fake = Awaited<ReturnType<typeof startFakeProvider>>;

const chatBody = (content: unknown, extra: Record<string, unknown> = {}) => ({
  model: 'fake-small',
  messages: [{ role: 'user', content }],
  ...extra,
});

describe('фейковый провайдер, часть без потока (спека 002, 4.12)', () => {
  let fake: Fake;

  beforeEach(async () => {
    fake = await startFakeProvider({ port: 0 });
  });

  afterEach(async () => {
    await fake.close();
  });

  const post = (body: unknown, headers: Record<string, string> = {}) =>
    fetch(`${fake.url}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });

  it('без маркера отдаёт chat.completion с usage и cost и записывает запрос', async () => {
    const body = chatBody('привет');
    const res = await post(body, { authorization: 'Bearer test-token' });

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
    const res = await post(chatBody('__fail_400__'), { authorization: 'Bearer fake-key-x' });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: { message: 'bad request, auth was: Bearer fake-key-x' },
    });
  });

  it('stream: true пока не реализован — 501 (поток — T-8)', async () => {
    const res = await post(chatBody('привет', { stream: true }));
    expect(res.status).toBe(501);
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
});
