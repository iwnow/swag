import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.ts';
import { loadNodeRegistry } from '../src/node-types.ts';
import { bearer, makeApi, makeBilling, makeStartedAuth, T } from './support.ts';

// Спека 021, 4.8: маршруты каталога через реальный загрузчик и реальное разрешение пакетов (exports), без подмены resolve.
const apps: FastifyInstance[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

const requireFromHere = createRequire(import.meta.url);

async function setup(): Promise<FastifyInstance> {
  const nodeTypes = await loadNodeRegistry(['@swag/node-llm-agent', '@swag/node-example']);
  const billing = await makeBilling();
  const { core } = await makeApi({ billing, nodeTypes });
  const app = await buildApp(core, billing, {}, (await makeStartedAuth({ core })).app);
  apps.push(app);
  return app;
}

const getNodeTypes = (app: FastifyInstance, token?: string) =>
  app.inject({
    method: 'GET',
    url: '/node-types',
    headers: token ? bearer(token) : {},
  });

describe('каталог типов узлов по HTTP', () => {
  it('AC-021-19: GET /node-types — 200, items в порядке example/echo, swag/llm-agent', async () => {
    const app = await setup();
    const response = await getNodeTypes(app, T.u1);
    expect(response.statusCode).toBe(200);
    const items = response.json<{ items: Array<{ type: string; version: string }> }>().items;
    expect(items.map((item) => item.type)).toEqual(['example/echo', 'swag/llm-agent']);
    expect(items.map((item) => item.version)).toEqual(['1.0.0', '1.0.0']);
  });

  it('AC-021-19: GET /node-types/example/echo/1.0.0 — 200 с манифестом из swag-node.json пакета', async () => {
    const app = await setup();
    const expected = JSON.parse(
      await readFile(requireFromHere.resolve('@swag/node-example/swag-node.json'), 'utf8'),
    ) as unknown;
    const response = await app.inject({
      method: 'GET',
      url: '/node-types/example/echo/1.0.0',
      headers: bearer(T.u1),
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(expected);
  });

  it('AC-021-19: GET /node-types/example/echo/9.9.9 — 404 not_found', async () => {
    const app = await setup();
    const response = await app.inject({
      method: 'GET',
      url: '/node-types/example/echo/9.9.9',
      headers: bearer(T.u1),
    });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({
      error: { code: 'not_found', message: 'Тип узла не найден' },
    });
  });

  it('AC-021-20: без токена GET /node-types и GET /node-types/:namespace/:name/:version — 401 unauthorized', async () => {
    const app = await setup();
    const list = await getNodeTypes(app);
    expect(list.statusCode).toBe(401);
    expect(list.json()).toMatchObject({ error: { code: 'unauthorized' } });
    const one = await app.inject({ method: 'GET', url: '/node-types/example/echo/1.0.0' });
    expect(one.statusCode).toBe(401);
    expect(one.json()).toMatchObject({ error: { code: 'unauthorized' } });
  });

  it('AC-021-21: каталог отдаётся по HTTP всем трём ролям, у которых есть node.read', async () => {
    const app = await setup();
    for (const token of [T.u1, T.adminA, T.sup]) {
      const response = await getNodeTypes(app, token);
      expect(response.statusCode).toBe(200);
    }
  });
});
