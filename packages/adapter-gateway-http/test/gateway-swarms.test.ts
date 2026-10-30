import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import type { LlmSwarmRegistration } from '@swag/contracts';
import { createGatewaySwarms, GatewayError } from '../src/index.ts';

// Спека 004, 4.6 (REQ-004-3): адаптер LlmSwarms на фейковом HTTP-сервере на 127.0.0.1, без сети.
interface Reply {
  status: number;
  body?: unknown;
  hang?: boolean;
}

interface Seen {
  method: string;
  url: string;
  authorization: string | undefined;
  contentType: string | undefined;
  body: string;
}

interface Fake {
  url: string;
  seen: Seen[];
}

let server: Server | undefined;
const pending: ServerResponse[] = [];

async function startFake(reply: Reply): Promise<Fake> {
  const fake: Fake = { url: '', seen: [] };
  server = createServer((request: IncomingMessage, response: ServerResponse) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk: string) => (body += chunk));
    request.on('end', () => {
      fake.seen.push({
        method: request.method ?? '',
        url: request.url ?? '',
        authorization: request.headers.authorization,
        contentType: request.headers['content-type'],
        body,
      });
      // Как Fastify: JSON-запрос с пустым телом — 400 (тело close без content-type проходит).
      if (request.headers['content-type']?.startsWith('application/json') && body === '') {
        response.writeHead(400, { 'content-type': 'application/json' });
        response.end(
          JSON.stringify({ error: { message: 'Body cannot be empty', code: 'bad_request' } }),
        );
        return;
      }
      if (reply.hang) {
        pending.push(response);
        return;
      }
      if (reply.status === 204) {
        response.writeHead(204).end();
        return;
      }
      response.writeHead(reply.status, { 'content-type': 'application/json' });
      response.end(JSON.stringify(reply.body ?? {}));
    });
  });
  await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  fake.url = `http://127.0.0.1:${port}`;
  return fake;
}

afterEach(async () => {
  for (const response of pending.splice(0)) response.destroy();
  server?.closeAllConnections();
  await new Promise<void>((resolve) => server?.close(() => resolve()) ?? resolve());
  server = undefined;
});

const TOKEN = 'x'.repeat(32);
const SWARM_ID = '6f1c3c2e-5b7a-4d8e-9a0b-1c2d3e4f5a6b';
const registration: LlmSwarmRegistration = {
  swarmId: SWARM_ID,
  budgetMicroUsd: 1000000,
  expiresAt: '2026-10-30T12:00:00.000Z',
  agents: [{ agentId: 'agent-1', model: 'test/model', budgetMicroUsd: null }],
};
const errorBody = (code: string) => ({ error: { message: `boom ${code}`, code } });

describe('adapter-gateway-http (спека 004, 4.6, REQ-004-3)', () => {
  it('register 204 — ok; POST на /internal/swarms с телом регистрации и Bearer-токеном', async () => {
    const fake = await startFake({ status: 204 });
    const swarms = createGatewaySwarms({ baseUrl: fake.url, token: TOKEN, timeoutMs: 1000 });
    await expect(swarms.register(registration)).resolves.toBeUndefined();
    expect(fake.seen).toHaveLength(1);
    expect(fake.seen[0]).toMatchObject({
      method: 'POST',
      url: '/internal/swarms',
      authorization: `Bearer ${TOKEN}`,
    });
    expect(JSON.parse(fake.seen[0]?.body ?? '')).toEqual(registration);
  });

  it.each([
    [400, 'invalid_request'],
    [403, 'caller_not_registered'],
    [409, 'swarm_registered'],
    [500, 'upstream_error'],
  ])('register %i — исключение GatewayError с кодом из тела %s', async (status, code) => {
    const fake = await startFake({ status, body: errorBody(code) });
    const swarms = createGatewaySwarms({ baseUrl: fake.url, token: TOKEN, timeoutMs: 1000 });
    const error = await swarms.register(registration).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GatewayError);
    expect(error).toMatchObject({ status, code, message: `boom ${code}` });
  });

  it('register с ответом без JSON — исключение с кодом http_<статус>', async () => {
    const fake = await startFake({ status: 502 });
    const swarms = createGatewaySwarms({ baseUrl: fake.url, token: TOKEN, timeoutMs: 1000 });
    const error = await swarms.register(registration).catch((e: unknown) => e);
    expect(error).toMatchObject({ status: 502, code: 'http_502' });
  });

  it.each([200, 204])(
    'close %i — ok; POST на /internal/swarms/:id/close с токеном',
    async (status) => {
      const fake = await startFake({ status, body: { spentMicroUsd: 0 } });
      const swarms = createGatewaySwarms({ baseUrl: fake.url, token: TOKEN, timeoutMs: 1000 });
      await expect(swarms.close(SWARM_ID)).resolves.toBeUndefined();
      expect(fake.seen[0]).toMatchObject({
        method: 'POST',
        url: `/internal/swarms/${SWARM_ID}/close`,
        authorization: `Bearer ${TOKEN}`,
        contentType: undefined,
      });
    },
  );

  it('close 404 — ok, рой уже не зарегистрирован', async () => {
    const fake = await startFake({ status: 404, body: errorBody('not_found') });
    const swarms = createGatewaySwarms({ baseUrl: fake.url, token: TOKEN, timeoutMs: 1000 });
    await expect(swarms.close(SWARM_ID)).resolves.toBeUndefined();
  });

  it('close 500 — исключение GatewayError с кодом из тела', async () => {
    const fake = await startFake({ status: 500, body: errorBody('upstream_error') });
    const swarms = createGatewaySwarms({ baseUrl: fake.url, token: TOKEN, timeoutMs: 1000 });
    const error = await swarms.close(SWARM_ID).catch((e: unknown) => e);
    expect(error).toMatchObject({ status: 500, code: 'upstream_error' });
  });

  it('таймаут — исключение (register и close), повторов нет', async () => {
    const fake = await startFake({ status: 204, hang: true });
    const swarms = createGatewaySwarms({ baseUrl: fake.url, token: TOKEN, timeoutMs: 50 });
    const registerError = await swarms.register(registration).catch((e: unknown) => e);
    const closeError = await swarms.close(SWARM_ID).catch((e: unknown) => e);
    expect(registerError).toMatchObject({ name: 'TimeoutError' });
    expect(closeError).toMatchObject({ name: 'TimeoutError' });
    expect(fake.seen).toHaveLength(2);
  });
});
