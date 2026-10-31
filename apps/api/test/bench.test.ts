import { describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.ts';
import { actorOf, bearer, body, makeApi, makeAuth, T, WHO } from './support.ts';

// NFR-024-2: проверка токена добавляет к p95 GET /swarms/:id не больше 5 мс. Запуск: API_BENCH=1 npx vitest run apps/api/test/bench.test.ts.
const REQUESTS = 200;
const WARMUP = 20;

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
});
