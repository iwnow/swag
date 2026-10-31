import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createMemorySwarmStore } from '@swag/adapter-memory';
import type { PlatformEvent, TokenRevocationList } from '@swag/contracts';
import { buildApp } from '../src/app.ts';
import { startServer } from '../src/start.ts';
import { createBlockHandler, createStreamRegistry } from '../src/streams.ts';
import {
  bearer,
  body,
  captureLog,
  makeAuth,
  makeCore,
  otherKeyToken,
  T,
  tokenOf,
  WHO,
  type AuthEnv,
} from './support.ts';

// Спека 024, T-13: доступ в оболочке api — токен, Actor, WebSocket, синхронизация отзывов (4.5, 4.6, 4.12).

const apps: FastifyInstance[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

// Синхронизация отзывов: список подменяется, интервал запускается вручную и ждём её завершения.
async function publish(env: AuthEnv, list: TokenRevocationList): Promise<void> {
  env.state.list = list;
  const before = env.state.fetches;
  env.tick();
  await vi.waitFor(() => expect(env.state.fetches).toBe(before + 1));
  await flush();
}

async function setup(options: { maxStaleMs?: number } = {}) {
  const log = captureLog();
  const stops: string[] = [];
  const store = createMemorySwarmStore();
  const core = makeCore(
    {
      launch: async () => undefined,
      stop: async (id) => {
        stops.push(id);
      },
    },
    log.logger,
    store,
  );
  const env = makeAuth({ core, maxStaleMs: options.maxStaleMs });
  await env.revocations.start();
  const app = await buildApp(core, { logger: { level: 'warn', stream: log.stream } }, env.app);
  apps.push(app);
  await app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return { app, core, env, log, stops, store, port };
}

const streamUrl = (port: number, id: string) => `ws://127.0.0.1:${port}/swarms/${id}/stream`;

// Событие потока в JSON-виде: нужны тип и стоимость провайдера.
type WireEvent = { type: string; data: { providerCostMicroUsd?: number | null } };

// Итог подключения: код закрытия, либо 'open', если соединение держится.
function streamResult(port: number, id: string, protocols: string[]): Promise<number | 'open'> {
  return new Promise((resolve) => {
    const socket = new WebSocket(streamUrl(port, id), protocols);
    socket.addEventListener('close', (event) => resolve(event.code));
    socket.addEventListener('open', () => {
      setTimeout(() => {
        if (socket.readyState !== WebSocket.OPEN) return;
        resolve('open');
        socket.close();
      }, 100);
    });
  });
}

// Первое событие заданного типа из потока; поток закрывается сразу.
function firstEvent(
  port: number,
  id: string,
  protocols: string[],
  type: string,
): Promise<WireEvent> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(streamUrl(port, id), protocols);
    socket.addEventListener('message', (message) => {
      const event = JSON.parse(String(message.data)) as WireEvent;
      if (event.type !== type) return;
      resolve(event);
      socket.close();
    });
    socket.addEventListener('close', (event) => reject(new Error(`закрыто ${event.code}`)));
  });
}

async function legacySwarm(store: ReturnType<typeof createMemorySwarmStore>, swarmId: string) {
  const event = {
    id: uuid(0x900),
    swarmId,
    ts: '2026-10-01T10:00:00.000Z',
    source: 'api',
    agentId: null,
    traceId: null,
    type: 'swarm.created',
    data: { task: 'до 024', budgetMicroUsd: 1000000, agents: [{ name: 'A', role: 'r' }] },
    seq: 1,
  } as PlatformEvent;
  await store.appendEvent(event);
}

const llmCall = (swarmId: string, providerCostMicroUsd: number) => ({
  id: uuid(0x501),
  swarmId,
  ts: '2026-10-22T10:00:02.000Z',
  source: 'llm-gateway',
  agentId: null,
  traceId: null,
  type: 'llm.call',
  data: {
    callId: uuid(0x502),
    model: 'chat-small',
    stream: false,
    status: 'ok',
    usage: { promptTokens: 1000, cachedPromptTokens: 200, completionTokens: 500 },
    costMicroUsd: 9960,
    providerCostMicroUsd,
    latencyMs: 812,
  },
});

describe('доступ в оболочке api', () => {
  it('AC-024-15: без токена, с битым, просроченным, чужим kid и отозванным — 401 unauthorized, warn auth_failed без токена; WebSocket — 4401; /health — 200', async () => {
    const { app, core, env, log, port } = await setup();
    const created = (
      await app.inject({ method: 'POST', url: '/swarms', headers: bearer(T.u1), payload: body(1) })
    ).json();
    const id: string = created.id;
    const now = Math.floor(Date.now() / 1000);
    const expired = await tokenOf(WHO.u1, { iat: now - 2000, exp: now - 1000 });
    const foreign = await otherKeyToken();
    const validAfter = Date.now() + 60_000;
    await publish(env, {
      revocations: [{ userId: WHO.u1.sub, validAfter, blocked: false }],
    });
    const cases: Array<{ reason: string; token: string | null; headers: Record<string, string> }> =
      [
        { reason: 'missing', token: null, headers: {} },
        { reason: 'invalid', token: 'not.a.jwt', headers: bearer('not.a.jwt') },
        { reason: 'invalid', token: expired, headers: bearer(expired) },
        { reason: 'invalid', token: foreign, headers: bearer(foreign) },
        { reason: 'revoked', token: T.u1, headers: bearer(T.u1) },
      ];
    const routes = [
      { method: 'GET' as const, url: '/swarms' },
      { method: 'POST' as const, url: '/swarms', payload: body(1) },
      { method: 'GET' as const, url: `/swarms/${id}` },
      { method: 'GET' as const, url: `/swarms/${id}/events` },
      { method: 'POST' as const, url: `/swarms/${id}/stop` },
    ];
    for (const c of cases) {
      for (const route of routes) {
        const response = await app.inject({ ...route, headers: c.headers });
        expect(response.statusCode, `${route.method} ${route.url} ${c.reason}`).toBe(401);
        expect(response.json().error.code).toBe('unauthorized');
      }
      const protocols = c.token === null ? ['swag.v1'] : ['swag.v1', `swag.bearer.${c.token}`];
      expect(await streamResult(port, id, protocols)).toBe(4401);
    }

    const health = await app.inject({ method: 'GET', url: '/health' });
    expect(health.statusCode).toBe(200);

    const failures = log.entries.filter((e) => e.msg === 'auth_failed');
    expect(failures).toHaveLength(cases.length * (routes.length + 1));
    expect(new Set(failures.map((e) => e.reason))).toEqual(
      new Set(['missing', 'invalid', 'revoked']),
    );
    for (const token of [expired, foreign, T.u1]) expect(log.text()).not.toContain(token);
    expect(core).toBeDefined();
  });

  it('AC-024-16: видимость роёв по REST и WebSocket — user видит свой, admin — свою организацию, user другой организации — ничего, supervisor — все, рой до 024 — только supervisor', async () => {
    const { app, env, store, port, stops } = await setup();
    const create = async (token: string) =>
      (
        await app.inject({
          method: 'POST',
          url: '/swarms',
          headers: bearer(token),
          payload: body(1),
        })
      ).json().id as string;
    const u1Swarm = await create(T.u1);
    const u2Swarm = await create(T.u2);
    const bSwarm = await create(T.b);
    const legacy = uuid(0xe1);
    await legacySwarm(store, legacy);
    const all = [u1Swarm, u2Swarm, bSwarm, legacy];
    const matrix: Array<[string, string, string[]]> = [
      ['user U1', T.u1, [u1Swarm]],
      ['user U2', T.u2, [u2Swarm]],
      ['admin A', T.adminA, [u1Swarm, u2Swarm]],
      ['user B', T.b, [bSwarm]],
      ['supervisor', T.sup, all],
    ];

    for (const [who, token, visible] of matrix) {
      const list = await app.inject({ method: 'GET', url: '/swarms', headers: bearer(token) });
      expect(
        list
          .json()
          .map((s: { id: string }) => s.id)
          .sort(),
        who,
      ).toEqual([...visible].sort());
      for (const id of all) {
        const allowed = visible.includes(id);
        const view = await app.inject({
          method: 'GET',
          url: `/swarms/${id}`,
          headers: bearer(token),
        });
        expect(view.statusCode, `${who} GET ${id}`).toBe(allowed ? 200 : 404);
        const events = await app.inject({
          method: 'GET',
          url: `/swarms/${id}/events`,
          headers: bearer(token),
        });
        expect(events.statusCode, `${who} events ${id}`).toBe(allowed ? 200 : 404);
        expect(await streamResult(port, id, ['swag.v1', `swag.bearer.${token}`])).toBe(
          allowed ? 'open' : 4404,
        );
        if (!allowed) {
          const stop = await app.inject({
            method: 'POST',
            url: `/swarms/${id}/stop`,
            headers: bearer(token),
          });
          expect(stop.statusCode, `${who} stop ${id}`).toBe(404);
        }
      }
    }
    expect(stops).toEqual([]);

    const forbidden = await app.inject({
      method: 'POST',
      url: '/swarms',
      headers: bearer(T.sup),
      payload: body(1),
    });
    expect(forbidden.statusCode).toBe(403);
    expect(forbidden.json().error.code).toBe('forbidden');

    const stop = await app.inject({
      method: 'POST',
      url: `/swarms/${u1Swarm}/stop`,
      headers: bearer(T.u1),
    });
    expect(stop.statusCode).toBe(202);
    expect(stops).toEqual([u1Swarm]);
    expect(env.state.fetches).toBeGreaterThan(0);
  });

  it('AC-024-18: providerCostMicroUsd — администратору null по REST и WebSocket, супервизору 42, в хранилище 42', async () => {
    const { app, core, store, port } = await setup();
    const swarmId = (
      await app.inject({
        method: 'POST',
        url: '/swarms',
        headers: bearer(T.adminA),
        payload: body(1),
      })
    ).json().id as string;
    await core.ingestEvent(llmCall(swarmId, 42));

    const costOf = (events: WireEvent[]) =>
      events.find((e) => e.type === 'llm.call')?.data.providerCostMicroUsd;

    const adminRest = await app.inject({
      method: 'GET',
      url: `/swarms/${swarmId}/events`,
      headers: bearer(T.adminA),
    });
    expect(costOf(adminRest.json())).toBeNull();
    const supRest = await app.inject({
      method: 'GET',
      url: `/swarms/${swarmId}/events`,
      headers: bearer(T.sup),
    });
    expect(costOf(supRest.json())).toBe(42);

    const adminWs = await firstEvent(
      port,
      swarmId,
      ['swag.v1', `swag.bearer.${T.adminA}`],
      'llm.call',
    );
    expect(adminWs.data.providerCostMicroUsd).toBeNull();
    const supWs = await firstEvent(port, swarmId, ['swag.v1', `swag.bearer.${T.sup}`], 'llm.call');
    expect(supWs.data.providerCostMicroUsd).toBe(42);

    const stored = await store.events(swarmId, 0);
    expect(costOf(stored as unknown as WireEvent[])).toBe(42);
  });

  it('AC-024-20: listen не выполняется до первой удачной синхронизации; после устаревания маршруты роёв — 503 auth_unavailable, /health — 200', async () => {
    const env = makeAuth();
    env.state.failing = true;
    const core = makeCore();
    const app = await buildApp(core, {}, env.app);
    apps.push(app);
    const listening: boolean[] = [];
    let attempts = 0;
    await startServer({
      app,
      revocations: env.revocations,
      pollMs: 1,
      host: '127.0.0.1',
      port: 0,
      wait: async () => {
        listening.push(app.server.listening);
        attempts += 1;
        if (attempts === 2) env.state.failing = false;
      },
    });
    expect(listening).toEqual([false, false]);
    expect(env.state.fetches).toBe(3);
    expect(app.server.listening).toBe(true);

    const created = (
      await app.inject({ method: 'POST', url: '/swarms', headers: bearer(T.u1), payload: body(1) })
    ).json();
    env.clock.now += 30_001;
    const stale = await app.inject({
      method: 'GET',
      url: `/swarms/${created.id}`,
      headers: bearer(T.u1),
    });
    expect(stale.statusCode).toBe(503);
    expect(stale.json().error.code).toBe('auth_unavailable');
    expect((await app.inject({ method: 'GET', url: '/health' })).statusCode).toBe(200);
  });

  it('AC-024-21: блокировка — оба активных роя пользователя остановлены, поток закрыт 4401, info user_swarms_stopped count 2; повторная синхронизация роёв не трогает', async () => {
    const { app, env, log, stops, port } = await setup();
    const create = async () =>
      (
        await app.inject({
          method: 'POST',
          url: '/swarms',
          headers: bearer(T.u1),
          payload: body(1),
        })
      ).json().id as string;
    const first = await create();
    const second = await create();

    const socket = new WebSocket(streamUrl(port, first), ['swag.v1', `swag.bearer.${T.u1}`]);
    await vi.waitFor(() => expect(socket.readyState).toBe(WebSocket.OPEN));
    const closed = new Promise<number>((resolve) =>
      socket.addEventListener('close', (event) => resolve(event.code)),
    );

    const validAfter = Date.now() + 60_000;
    const blocked: TokenRevocationList = {
      revocations: [{ userId: WHO.u1.sub, validAfter, blocked: true }],
    };
    await publish(env, blocked);
    await vi.waitFor(() => expect(stops.sort()).toEqual([first, second].sort()));
    expect(await closed).toBe(4401);
    expect(log.entries.find((e) => e.msg === 'user_swarms_stopped')).toMatchObject({
      level: 'info',
      userId: WHO.u1.sub,
      count: 2,
    });

    await publish(env, blocked);
    expect(stops).toHaveLength(2);
    expect(log.text()).not.toContain(T.u1);
  });
});

describe('блокировка пользователя', () => {
  it('AC-024-21: остановка роёв упала — потоки всё равно закрыты 4401, ошибка уходит дальше для повтора синхронизации', async () => {
    const closed: Array<[number, string]> = [];
    const streams = createStreamRegistry();
    streams.add(WHO.u1.sub, { close: (code, reason) => closed.push([code, reason]) });
    const core = {
      stopSwarmsOfUser: async () => {
        throw new Error('orchestrator down');
      },
    };
    const onBlocked = createBlockHandler(core, streams);
    await expect(onBlocked(WHO.u1.sub)).rejects.toThrow('orchestrator down');
    expect(closed).toEqual([[4401, 'unauthorized']]);
  });
});

describe('секреты в логах', () => {
  it('AC-024-25: после отказов, WebSocket и блокировки в логах оболочки нет токенов доступа и email', async () => {
    const { app, env, log, port } = await setup();
    const id = (
      await app.inject({ method: 'POST', url: '/swarms', headers: bearer(T.u1), payload: body(1) })
    ).json().id as string;
    await app.inject({ method: 'GET', url: `/swarms/${id}`, headers: bearer('not.a.jwt') });
    await app.inject({ method: 'GET', url: `/swarms/${id}` });
    await app.inject({ method: 'GET', url: `/swarms/${id}`, headers: bearer(T.b) });
    expect(await streamResult(port, id, ['swag.v1', `swag.bearer.${T.u2}`])).toBe(4404);
    await publish(env, {
      revocations: [{ userId: WHO.u1.sub, validAfter: Date.now() + 60_000, blocked: true }],
    });
    await vi.waitFor(() =>
      expect(log.entries.some((e) => e.msg === 'user_swarms_stopped')).toBe(true),
    );

    const text = log.text();
    for (const token of Object.values(T)) expect(text).not.toContain(token);
    expect(text).not.toContain('swag.bearer');
    expect(text).not.toMatch(/@/);
  });
});
