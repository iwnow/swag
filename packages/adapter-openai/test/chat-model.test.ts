import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import type { ChatModelRequest } from '@swag/agent-core';
import { startFakeProvider, type FakeProvider } from '../../../infra/llm/fake-provider/server.ts';
import { createOpenAiChatModel, type OpenAiChatModelOptions } from '../src/index.ts';

const TOKEN = 'llm-token-not-secret';
const TRACEPARENT = '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01';

const request = (content: string): ChatModelRequest => ({
  model: 'chat-small',
  messages: [
    { role: 'system', content: 'Ты агент.' },
    { role: 'user', content },
  ],
  tools: [
    {
      name: 'send_message',
      description: 'Написать агенту',
      parameters: { type: 'object', properties: { to: { type: 'string' } }, required: ['to'] },
    },
  ],
  maxTokens: 256,
});

const optionsFor = (baseUrl: string, overrides: Partial<OpenAiChatModelOptions> = {}) => ({
  baseUrl,
  token: TOKEN,
  caller: { swarmId: 'swarm-1', agentId: 'agent-1' },
  traceparent: () => TRACEPARENT,
  timeoutMs: 5_000,
  maxRetries: 0,
  ...overrides,
});

const servers: Server[] = [];
const fakes: FakeProvider[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))),
  );
  await Promise.all(fakes.splice(0).map((fake) => fake.close()));
});

async function fake(): Promise<FakeProvider> {
  const provider = await startFakeProvider({ port: 0 });
  fakes.push(provider);
  return provider;
}

// Подставной gateway с одним ответом; эхо токена в теле проверяет редактирование в message.
async function stubGateway(status: number, body: unknown): Promise<string> {
  const server = createServer((req, res) => {
    const auth = req.headers.authorization ?? '';
    const text = JSON.stringify(body).replaceAll('TOKEN_ECHO', auth);
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(text);
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('нет адреса заглушки');
  return `http://127.0.0.1:${String(address.port)}/v1`;
}

describe('createOpenAiChatModel', () => {
  it('AC-022-19: запрос к фейку с инструментами — путь, заголовки, тело; ответ — tool_calls из маркера', async () => {
    const provider = await fake();
    const model = createOpenAiChatModel(optionsFor(`${provider.url}/v1`));

    const result = await model.complete(
      request('__tool_calls__[{"name":"send_message","arguments":{"to":"agent-2"}}]'),
    );

    expect(result).toEqual({
      ok: true,
      message: {
        content: null,
        tool_calls: [
          {
            id: 'call_0',
            type: 'function',
            function: { name: 'send_message', arguments: '{"to":"agent-2"}' },
          },
        ],
      },
    });
    const [sent] = provider.requests;
    expect(sent?.path).toBe('/v1/chat/completions');
    expect(sent?.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(sent?.headers['x-swag-swarm-id']).toBe('swarm-1');
    expect(sent?.headers['x-swag-agent-id']).toBe('agent-1');
    expect(sent?.headers.traceparent).toBe(TRACEPARENT);
    expect(sent?.body).toMatchObject({
      model: 'chat-small',
      max_tokens: 256,
      stream: false,
      tools: [
        {
          type: 'function',
          function: { name: 'send_message', description: 'Написать агенту' },
        },
      ],
    });
  });

  it('AC-022-19: без traceparent из контекста заголовка нет', async () => {
    const provider = await fake();
    const model = createOpenAiChatModel(
      optionsFor(`${provider.url}/v1`, { traceparent: () => null }),
    );

    await model.complete(request('привет'));

    expect(provider.requests[0]?.headers).not.toHaveProperty('traceparent');
  });

  it('AC-022-19: 429 без кода в теле и maxRetries 0 — rate_limited', async () => {
    const provider = await fake();
    const model = createOpenAiChatModel(optionsFor(`${provider.url}/v1`));

    const result = await model.complete(request('__fail_429__'));

    expect(result).toMatchObject({ ok: false, error: { code: 'rate_limited' } });
    expect(provider.requests).toHaveLength(1);
  });

  it('AC-022-19: 400 с error.code model_not_found — model_not_found, токен в message заменён на ***', async () => {
    const baseUrl = await stubGateway(400, {
      error: { code: 'model_not_found', message: `unknown model, auth was TOKEN_ECHO` },
    });
    const model = createOpenAiChatModel(optionsFor(baseUrl));

    const result = await model.complete(request('привет'));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('model_not_found');
    expect(result.error.message).toContain('***');
    expect(result.error.message).not.toContain(TOKEN);
  });

  it('AC-022-19: без сервера — network', async () => {
    const provider = await fake();
    const { url } = provider;
    await provider.close();
    fakes.splice(fakes.indexOf(provider), 1);
    const model = createOpenAiChatModel(optionsFor(`${url}/v1`));

    const result = await model.complete(request('привет'));

    expect(result).toMatchObject({ ok: false, error: { code: 'network' } });
  });

  it('AC-022-19: зависший gateway при timeoutMs 200 — timeout', async () => {
    const provider = await fake();
    const model = createOpenAiChatModel(optionsFor(`${provider.url}/v1`, { timeoutMs: 200 }));

    const result = await model.complete(request('__hang__'));

    expect(result).toMatchObject({ ok: false, error: { code: 'timeout' } });
  });

  it('AC-022-19: 400 без кода в теле — upstream_error, токен из message убран', async () => {
    const provider = await fake();
    const model = createOpenAiChatModel(optionsFor(`${provider.url}/v1`));

    const result = await model.complete(request('__fail_400__'));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('upstream_error');
    expect(result.error.message).not.toContain(TOKEN);
  });

  it('AC-022-19: ответ без choices[0] — invalid_response', async () => {
    const baseUrl = await stubGateway(200, { id: 'x', object: 'chat.completion', choices: [] });
    const model = createOpenAiChatModel(optionsFor(baseUrl));

    const result = await model.complete(request('привет'));

    expect(result).toMatchObject({ ok: false, error: { code: 'invalid_response' } });
  });

  it('AC-022-19: finish_reason length с непустым content — max_tokens, текст не отдаётся как ответ', async () => {
    const baseUrl = await stubGateway(200, {
      id: 'x',
      object: 'chat.completion',
      choices: [
        {
          index: 0,
          finish_reason: 'length',
          message: { role: 'assistant', content: 'недописанная мысль' },
        },
      ],
    });
    const model = createOpenAiChatModel(optionsFor(baseUrl));

    const result = await model.complete(request('привет'));

    expect(result).toMatchObject({ ok: false, error: { code: 'max_tokens' } });
    expect(result.ok === false && result.error.message).toContain('max_tokens');
    expect(result.ok === false && result.error.message).toContain('256');
  });

  it('AC-022-19: finish_reason length с tool_calls — max_tokens, вызов не отдаётся', async () => {
    const baseUrl = await stubGateway(200, {
      id: 'x',
      object: 'chat.completion',
      choices: [
        {
          index: 0,
          finish_reason: 'length',
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                id: 'call_1',
                type: 'function',
                function: { name: 'send_message', arguments: '{"to":"agent-2"}' },
              },
            ],
          },
        },
      ],
    });
    const model = createOpenAiChatModel(optionsFor(baseUrl));

    const result = await model.complete(request('привет'));

    expect(result).toMatchObject({ ok: false, error: { code: 'max_tokens' } });
  });
});
