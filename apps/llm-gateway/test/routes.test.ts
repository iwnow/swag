import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { PlatformEventInput } from '@swag/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.ts';
import { startFakeProvider, type FakeProvider } from '../../../infra/llm/fake-provider/server.ts';
import { GATEWAY_TOKEN, gatewayOptions, makeCore, recordingLog } from './support.ts';

// Спека 002, 4.2 и 4.6: оболочка против фейка. Отказы до ядра и до апстрима не вызывают фейк и не публикуют событий.

const SWARM_ID = randomUUID();
const validBody = { model: 'chat-small', messages: [{ role: 'user', content: 'hi' }] };
const authorized = { authorization: `Bearer ${GATEWAY_TOKEN}` };
const caller = { ...authorized, 'x-swag-swarm-id': SWARM_ID, 'x-swag-agent-id': 'agent-1' };

interface Gateway {
  app: FastifyInstance;
  fake: FakeProvider;
  events: PlatformEventInput[];
}

const closers: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const close of closers.splice(0)) await close();
});

async function openGateway(bodyLimitBytes?: number): Promise<Gateway> {
  const fake = await startFakeProvider({ port: 0 });
  closers.push(() => fake.close());
  const events: PlatformEventInput[] = [];
  const { log } = recordingLog();
  const core = makeCore(fake.url, log, { publishEvent: async (event) => void events.push(event) });
  const app = await buildApp(core, {
    ...gatewayOptions,
    ...(bodyLimitBytes && { bodyLimitBytes }),
  });
  closers.push(() => app.close());
  return { app, fake, events };
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
    const gateway = await openGateway(1024);
    const big = { ...validBody, messages: [{ role: 'user', content: 'x'.repeat(2000) }] };

    const response = await chat(gateway, big, caller);

    expect(response.statusCode).toBe(413);
    expect(response.json()).toEqual(error('invalid_request'));
    expect(gateway.fake.requests).toEqual([]);
    expect(gateway.events).toEqual([]);
  });

  it('без токена тело больше лимита — 401, а не 413: токен проверяется до разбора тела', async () => {
    const gateway = await openGateway(1024);
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

  it('валидный вызов доходит до апстрима с телом запроса (ответ до T-22 — 501)', async () => {
    const gateway = await openGateway();

    const response = await chat(gateway, validBody, caller);

    expect(gateway.fake.requests).toHaveLength(1);
    expect(gateway.fake.requests[0]?.body).toEqual(validBody);
    expect(response.statusCode).toBe(501);
  });
});
