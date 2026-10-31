import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createApiCore, type Billing } from '@swag/api-core';
import { createMemorySwarmStore } from '@swag/adapter-memory';
import { createPostgresBalanceStore, runMigrations } from '@swag/adapter-postgres';
import { createBillingCore, type BillingCore } from '@swag/billing-core';
import { buildApp } from '../src/app.ts';
import { actorOf, bearer, body, makeApi, makeAuth, ORG_A, silentLog, T, WHO } from './support.ts';

// NFR-024-2: проверка токена добавляет к p95 GET /swarms/:id не больше 5 мс. Запуск: API_BENCH=1 npx vitest run apps/api/test/bench.test.ts.
// NFR-013-1: резерв добавляет к p95 POST /swarms не больше 5 мс; с Postgres — POSTGRES_TEST_URL.
const REQUESTS = 200;
const WARMUP = 20;
const BENCH_BUDGET_MICRO_USD = 1000;
const FUND_MICRO_USD = 1_000_000;
const MAX_TOPUP_MICRO_USD = 100_000_000;
const postgresUrl = process.env['POSTGRES_TEST_URL'];

const percentile = (values: number[], p: number): number => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.ceil((p / 100) * sorted.length) - 1] ?? 0;
};

async function measure(
  app: FastifyInstance,
  url: string,
  headers: Record<string, string>,
): Promise<number[]> {
  for (let i = 0; i < WARMUP; i += 1) await app.inject({ method: 'GET', url, headers });
  const times: number[] = [];
  for (let i = 0; i < REQUESTS; i += 1) {
    const start = performance.now();
    const response = await app.inject({ method: 'GET', url, headers });
    times.push(performance.now() - start);
    expect(response.statusCode).toBe(200);
  }
  return times;
}

describe.skipIf(process.env['API_BENCH'] !== '1')('api [bench]', () => {
  it('NFR-024-2: p95 GET /swarms/:id с проверкой токена и без неё отличается не больше чем на 5 мс', async () => {
    const { core, billing } = await makeApi();
    const env = makeAuth({ core });
    await env.revocations.start();
    const checked = await buildApp(core, billing, {}, env.app);
    // Без проверки: тот же маршрут и хук, но authenticate возвращает фиксированный Actor без разбора токена.
    const bypass = await buildApp(
      core,
      billing,
      {},
      {
        authenticate: async () => ({ ok: true, actor: actorOf(WHO.u1) }),
        streams: env.streams,
      },
    );
    const created = await checked.inject({
      method: 'POST',
      url: '/swarms',
      headers: bearer(T.u1),
      payload: body(1),
    });
    const url = `/swarms/${created.json().id as string}`;

    const withCheck = await measure(checked, url, bearer(T.u1));
    const withoutCheck = await measure(bypass, url, {});
    const p50With = percentile(withCheck, 50);
    const p95With = percentile(withCheck, 95);
    const p50Without = percentile(withoutCheck, 50);
    const p95Without = percentile(withoutCheck, 95);
    const diff = p95With - p95Without;
    console.log(
      `NFR-024-2 GET /swarms/:id, ${REQUESTS} запросов: с проверкой p50=${p50With.toFixed(3)} мс p95=${p95With.toFixed(3)} мс; без проверки p50=${p50Without.toFixed(3)} мс p95=${p95Without.toFixed(3)} мс; разница p95=${diff.toFixed(3)} мс`,
    );
    expect(diff).toBeLessThanOrEqual(5);

    await checked.close();
    await bypass.close();
  }, 120_000);

  it.skipIf(!postgresUrl)(
    'NFR-013-1: p95 POST /swarms с резервом на Postgres отличается от фейка Billing не больше чем на 5 мс',
    async () => {
      const env = makeAuth();
      await env.revocations.start();
      const schema = `bench_${randomUUID().replaceAll('-', '')}`;
      const admin = new pg.Client({ connectionString: postgresUrl ?? '' });
      await admin.connect();
      await admin.query(`create schema ${schema}`);
      const pool = new pg.Pool({
        connectionString: postgresUrl,
        options: `-c search_path=${schema}`,
      });
      try {
        await runMigrations(postgresUrl ?? '', { schema });
        const billing = createBillingCore({
          store: createPostgresBalanceStore(pool),
          orgs: { exists: async (orgId) => orgId === ORG_A },
          clock: { now: () => new Date().toISOString() },
          log: silentLog,
          limits: { maxTopupMicroUsd: MAX_TOPUP_MICRO_USD },
        });
        await billing.topup(actorOf(WHO.sup), ORG_A, {
          amountMicroUsd: FUND_MICRO_USD,
          comment: 'бенчмарк',
        });
        const fake: Billing = {
          reserve: async () => 'ok',
          settle: async () => undefined,
          holds: async () => [],
        };

        const withFake = await swarmApp(fake, billing, env.app);
        const withPostgres = await swarmApp(billing, billing, env.app);
        const fakeTimes = await measureSwarms(withFake);
        const postgresTimes = await measureSwarms(withPostgres);
        const p95Fake = percentile(fakeTimes, 95);
        const p95Postgres = percentile(postgresTimes, 95);
        const diff = p95Postgres - p95Fake;
        console.log(
          `NFR-013-1 POST /swarms, ${REQUESTS} запросов: фейк Billing p50=${percentile(fakeTimes, 50).toFixed(3)} мс p95=${p95Fake.toFixed(3)} мс; billing-core на Postgres p50=${percentile(postgresTimes, 50).toFixed(3)} мс p95=${p95Postgres.toFixed(3)} мс; прирост p95=${diff.toFixed(3)} мс`,
        );
        expect(diff).toBeLessThanOrEqual(5);

        await withFake.close();
        await withPostgres.close();
      } finally {
        await pool.end();
        await admin.query(`drop schema ${schema} cascade`);
        await admin.end();
      }
    },
    300_000,
  );
});

// Резерв — порт Billing; маршруты баланса в замере не участвуют, поэтому передаётся billing-core.
async function swarmApp(
  billing: Billing,
  routes: BillingCore,
  auth: Parameters<typeof buildApp>[3],
): Promise<FastifyInstance> {
  const core = createApiCore({
    version: 'bench',
    store: createMemorySwarmStore(),
    orchestrator: { launch: async () => undefined, stop: async () => undefined },
    billing,
    clock: { now: () => new Date().toISOString() },
    ids: { uuid: () => randomUUID() },
    log: silentLog,
    trace: { currentTraceId: () => null },
    limits: { maxActiveSwarms: 10_000, maxBudgetMicroUsd: 5_000_000, maxTokens: 65536 },
  });
  return buildApp(core, routes, {}, auth);
}

async function measureSwarms(app: FastifyInstance): Promise<number[]> {
  const payload = { ...body(1), budgetMicroUsd: BENCH_BUDGET_MICRO_USD };
  const post = () => app.inject({ method: 'POST', url: '/swarms', headers: bearer(T.u1), payload });
  for (let i = 0; i < WARMUP; i += 1) await post();
  const times: number[] = [];
  for (let i = 0; i < REQUESTS; i += 1) {
    const start = performance.now();
    const response = await post();
    times.push(performance.now() - start);
    expect(response.statusCode).toBe(201);
  }
  return times;
}
