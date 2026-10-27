import { randomUUID } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { FastifyInstance } from 'fastify';
import { PlatformEventInput } from '@swag/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.ts';
import { startFakeProvider, type FakeProvider } from '../../../infra/llm/fake-provider/server.ts';
import {
  GATEWAY_TOKEN,
  createMemoryBus,
  gatewayOptions,
  makeCore,
  recordingLog,
  type LogEntry,
} from './support.ts';

// Спека 002, 4.2 и 4.6: оболочка против фейка. Отказы до ядра и до апстрима не вызывают фейк и не публикуют событий.

const SWARM_ID = randomUUID();
const validBody = { model: 'chat-small', messages: [{ role: 'user', content: 'hi' }] };
const authorized = { authorization: `Bearer ${GATEWAY_TOKEN}` };
const caller = { ...authorized, 'x-swag-swarm-id': SWARM_ID, 'x-swag-agent-id': 'agent-1' };

interface Gateway {
  app: FastifyInstance;
  fake: FakeProvider;
  events: PlatformEventInput[];
  logs: LogEntry[];
}

const closers: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const close of closers.splice(0)) await close();
});

// События уходят в шину в памяти и читаются подпиской, как у api (REQ-002-7).
async function openGateway(
  options: { bodyLimitBytes?: number; idleTimeoutMs?: number; traceId?: string } = {},
): Promise<Gateway> {
  const fake = await startFakeProvider({ port: 0 });
  closers.push(() => fake.close());
  const bus = createMemoryBus<PlatformEventInput>();
  const events: PlatformEventInput[] = [];
  bus.subscribe(`swarm.${SWARM_ID}.events`, (event) => void events.push(event));
  const { log, entries } = recordingLog();
  const core = makeCore(
    fake.url,
    log,
    { publishEvent: async (event) => bus.publish(`swarm.${event.swarmId}.events`, event) },
    {
      ...(options.idleTimeoutMs && { idleTimeoutMs: options.idleTimeoutMs }),
      ...(options.traceId && { traceId: options.traceId }),
    },
  );
  const app = await buildApp(core, {
    ...gatewayOptions,
    ...(options.bodyLimitBytes && { bodyLimitBytes: options.bodyLimitBytes }),
  });
  closers.push(() => app.close());
  return { app, fake, events, logs: entries };
}

const chat = (gateway: Gateway, payload: unknown, headers: Record<string, string>) =>
  gateway.app.inject({
    method: 'POST',
    url: '/v1/chat/completions',
    headers: { 'content-type': 'application/json', ...headers },
    payload: typeof payload === 'string' ? payload : JSON.stringify(payload),
  });

const error = (code: string, message?: string) => ({
  error: {
    message: message ?? expect.any(String),
    type: 'swag_gateway_error',
    code,
  },
});

describe('оболочка llm-gateway: маршруты против фейка (спека 002, 4.2)', () => {
  it('AC-002-2: без токена, с чужим токеном и с токеном другой длины — 401 на обоих маршрутах, фейк и события не трогаются', async () => {
    const gateway = await openGateway();
    const wrong = 'x'.repeat(GATEWAY_TOKEN.length);
    const cases = [
      {},
      { authorization: `Bearer ${wrong}` },
      { authorization: 'Bearer short' },
      { authorization: GATEWAY_TOKEN },
    ];

    for (const headers of cases) {
      const withCaller = { ...headers, 'x-swag-swarm-id': SWARM_ID, 'x-swag-agent-id': 'agent-1' };
      const posted = await chat(gateway, validBody, withCaller);
      const listed = await gateway.app.inject({ method: 'GET', url: '/v1/models', headers });
      expect(posted.statusCode).toBe(401);
      expect(posted.json()).toEqual(error('unauthorized', 'Invalid gateway token'));
      expect(listed.statusCode).toBe(401);
      expect(listed.json()).toEqual(error('unauthorized', 'Invalid gateway token'));
    }
    expect(gateway.fake.requests).toEqual([]);
    expect(gateway.events).toEqual([]);
  });

  it('AC-002-3: нет swarm id, swarm id не UUID или agent id «bob» — 400 invalid_caller, фейк и события не трогаются', async () => {
    const gateway = await openGateway();
    const cases = [
      { ...authorized, 'x-swag-agent-id': 'agent-1' },
      { ...caller, 'x-swag-swarm-id': 'swarm-1' },
      { ...caller, 'x-swag-agent-id': 'bob' },
    ];

    for (const headers of cases) {
      const response = await chat(gateway, validBody, headers);
      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual(
        error('invalid_caller', 'Missing or invalid x-swag-swarm-id / x-swag-agent-id'),
      );
    }
    expect(gateway.fake.requests).toEqual([]);
    expect(gateway.events).toEqual([]);
  });

  it('AC-002-4: модель нет в каталоге — 400 model_not_found, фейк и события не трогаются', async () => {
    const gateway = await openGateway();

    const response = await chat(gateway, { ...validBody, model: 'gpt-unknown' }, caller);

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual(error('model_not_found', 'Unknown model: gpt-unknown'));
    expect(gateway.fake.requests).toEqual([]);
    expect(gateway.events).toEqual([]);
  });

  it('AC-002-5: без messages, messages: [] и тело-массив — 400 invalid_request, фейк не вызван', async () => {
    const gateway = await openGateway();
    const cases = [{ model: 'chat-small' }, { ...validBody, messages: [] }, [validBody]];

    for (const payload of cases) {
      const response = await chat(gateway, payload, caller);
      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual(error('invalid_request'));
    }
    expect(gateway.fake.requests).toEqual([]);
  });

  it('AC-002-6: GET /v1/models с токеном — список каталога в порядке фикстуры, owned_by swag', async () => {
    const gateway = await openGateway();

    const response = await gateway.app.inject({
      method: 'GET',
      url: '/v1/models',
      headers: authorized,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      object: 'list',
      data: [
        { id: 'chat-small', object: 'model', owned_by: 'swag' },
        { id: 'chat-large', object: 'model', owned_by: 'swag' },
      ],
    });
  });

  it('AC-002-28: поля api_key, api_base и extra_headers в теле — 400 invalid_request с именем поля, фейк и события не трогаются', async () => {
    const gateway = await openGateway();
    const cases = [
      ['api_key', { ...validBody, api_key: 'sk-x' }],
      ['api_base', { ...validBody, api_base: 'http://evil.test' }],
      ['extra_headers', { ...validBody, extra_headers: { 'x-evil': '1' } }],
    ] as const;

    for (const [field, payload] of cases) {
      const response = await chat(gateway, payload, caller);
      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual(
        error('invalid_request', `Client-side provider credentials are not allowed: ${field}`),
      );
    }
    expect(gateway.fake.requests).toEqual([]);
    expect(gateway.events).toEqual([]);
  });

  it('тело больше LLM_GATEWAY_BODY_LIMIT_BYTES — 413 с телом ошибки по 4.2, фейк не вызван', async () => {
    const gateway = await openGateway({ bodyLimitBytes: 1024 });
    const big = { ...validBody, messages: [{ role: 'user', content: 'x'.repeat(2000) }] };

    const response = await chat(gateway, big, caller);

    expect(response.statusCode).toBe(413);
    expect(response.json()).toEqual(error('invalid_request'));
    expect(gateway.fake.requests).toEqual([]);
    expect(gateway.events).toEqual([]);
  });

  it('без токена тело больше лимита — 401, а не 413: токен проверяется до разбора тела', async () => {
    const gateway = await openGateway({ bodyLimitBytes: 1024 });
    const big = { ...validBody, messages: [{ role: 'user', content: 'x'.repeat(2000) }] };

    const response = await chat(gateway, big, {
      'x-swag-swarm-id': SWARM_ID,
      'x-swag-agent-id': 'agent-1',
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual(error('unauthorized', 'Invalid gateway token'));
    expect(gateway.fake.requests).toEqual([]);
  });

  it('тело не JSON при валидном токене — 400 invalid_request по 4.2, фейк не вызван', async () => {
    const gateway = await openGateway();

    const response = await chat(gateway, '{not json', caller);

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual(error('invalid_request'));
    expect(gateway.fake.requests).toEqual([]);
  });
});

const TRACE_ID = '4bf92f3577b34da6a3ce929d0e0e4736';
const hangBody = { ...validBody, messages: [{ role: 'user', content: '__hang__' }] };

async function until(check: () => boolean, ms = 1000): Promise<void> {
  const deadline = performance.now() + ms;
  while (!check()) {
    if (performance.now() > deadline) throw new Error(`условие не выполнилось за ${ms} мс`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe('оболочка llm-gateway: ответ JSON и отмена (спека 002, 4.2, 4.6)', () => {
  it('AC-002-1: без потока с tools, tool_choice и temperature — 200, тело как у фейка, фейк получил тело как отправлено', async () => {
    const gateway = await openGateway();
    const sent = {
      model: 'chat-small',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [
        { type: 'function', function: { name: 'get_weather', parameters: { type: 'object' } } },
      ],
      tool_choice: 'auto',
      temperature: 0.2,
    };

    const response = await chat(gateway, sent, caller);

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      id: 'chatcmpl-fake',
      object: 'chat.completion',
      created: expect.any(Number),
      model: 'chat-small',
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                id: 'call_fake_1',
                type: 'function',
                function: { name: 'get_weather', arguments: '{}' },
              },
            ],
          },
          finish_reason: 'tool_calls',
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
    expect(gateway.fake.requests).toHaveLength(1);
    expect(gateway.fake.requests[0]?.body).toEqual(sent);
  });

  it('AC-002-9: успешный вызов без потока — ровно одно llm.call в шине с traceId запроса, проходит PlatformEventInput', async () => {
    const gateway = await openGateway({ traceId: TRACE_ID });

    const response = await chat(gateway, validBody, caller);

    expect(response.statusCode).toBe(200);
    expect(gateway.events).toHaveLength(1);
    expect(PlatformEventInput.safeParse(gateway.events[0]).success).toBe(true);
    expect(gateway.events[0]).toMatchObject({
      type: 'llm.call',
      source: 'llm-gateway',
      agentId: 'agent-1',
      traceId: TRACE_ID,
      data: {
        status: 'ok',
        stream: false,
        usage: { promptTokens: 1000, cachedPromptTokens: 200, completionTokens: 500 },
        costMicroUsd: 9960,
      },
    });
  });

  it('AC-002-14: фейк без usage — 200, событие ok с usage null и costMicroUsd null, лог warn usage_missing с callId', async () => {
    const gateway = await openGateway();
    const body = { ...validBody, messages: [{ role: 'user', content: '__no_usage__' }] };

    const response = await chat(gateway, body, caller);

    expect(response.statusCode).toBe(200);
    expect(gateway.events).toHaveLength(1);
    expect(gateway.events[0]).toMatchObject({
      data: { status: 'ok', usage: null, costMicroUsd: null },
    });
    expect(gateway.logs).toContainEqual({
      level: 'warn',
      msg: 'usage_missing',
      ctx: { callId: expect.any(String) },
    });
  });

  it('AC-002-15: без потока — 502 upstream_error, 429 rate_limited, 400 upstream_bad_request с bad request; событие error с тем же кодом', async () => {
    const gateway = await openGateway();
    const cases = [
      { marker: '__fail_500__', status: 502, code: 'upstream_error', message: 'Upstream error' },
      { marker: '__fail_429__', status: 429, code: 'rate_limited', message: 'Provider rate limit' },
      { marker: '__fail_400__', status: 400, code: 'upstream_bad_request', message: 'bad request' },
    ];

    for (const { marker, status, code, message } of cases) {
      const body = { ...validBody, messages: [{ role: 'user', content: marker }] };
      const response = await chat(gateway, body, caller);
      const failure = response.json() as { error: { message: string; code: string } };
      expect(response.statusCode).toBe(status);
      expect(failure.error.code).toBe(code);
      expect(failure.error.message).toContain(message);
    }
    expect(gateway.events).toMatchObject(
      cases.map(({ code }) => ({ data: { status: 'error', stream: false, errorCode: code } })),
    );
  });

  it('AC-002-16: таймаут простоя 200 мс, __hang__ — через 200–1000 мс 504 upstream_timeout, событие error с upstream_timeout', async () => {
    const gateway = await openGateway({ idleTimeoutMs: 200 });
    const started = performance.now();

    const response = await chat(gateway, hangBody, caller);
    const elapsed = performance.now() - started;

    expect(response.statusCode).toBe(504);
    expect(response.json()).toEqual(error('upstream_timeout', 'Upstream timeout'));
    expect(elapsed).toBeGreaterThanOrEqual(200);
    expect(elapsed).toBeLessThan(1000);
    expect(gateway.events).toMatchObject([
      { data: { status: 'error', errorCode: 'upstream_timeout' } },
    ]);
  });

  it('обычный вызов по сети (не inject) — 200: отмена не срабатывает на закрытии запроса после чтения тела (D-67, без AC-id)', async () => {
    const gateway = await openGateway();
    await gateway.app.listen({ port: 0, host: '127.0.0.1' });
    const { port } = gateway.app.server.address() as AddressInfo;

    const response = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: 'POST',
      headers: { ...caller, 'content-type': 'application/json' },
      body: JSON.stringify(validBody),
    });

    expect(response.status).toBe(200);
    expect(gateway.events).toMatchObject([{ data: { status: 'ok' } }]);
  });

  it('клиент ушёл до ответа — вызов апстрима отменён: фейк видит закрытие, событие error upstream_error по D-58 (без AC-id)', async () => {
    const gateway = await openGateway();
    await gateway.app.listen({ port: 0, host: '127.0.0.1' });
    const { port } = gateway.app.server.address() as AddressInfo;
    const request = http.request({
      host: '127.0.0.1',
      port,
      method: 'POST',
      path: '/v1/chat/completions',
      headers: { ...caller, 'content-type': 'application/json' },
    });
    request.on('error', () => undefined);
    request.end(JSON.stringify(hangBody));
    await until(() => gateway.fake.requests.length === 1);

    request.destroy();

    await until(
      () => gateway.fake.requests[0]?.closedByClient === true && gateway.events.length === 1,
    );
    expect(gateway.events).toMatchObject([
      { data: { status: 'error', errorCode: 'upstream_error' } },
    ]);
  });
});
