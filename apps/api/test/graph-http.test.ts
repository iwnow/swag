import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.ts';
import { loadNodeRegistry } from '@swag/node-packages';
import { bearer, makeApi, makeBilling, makeStartedAuth, T } from './support.ts';

// Спека 009, 4.9 и 5 (AC-009-12, AC-009-13, AC-009-15): граф по HTTP — POST /swarms и POST /graph-checks.
const apps: FastifyInstance[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

async function setup(): Promise<FastifyInstance> {
  const nodeTypes = await loadNodeRegistry(['@swag/node-llm-agent', '@swag/node-example']);
  const billing = await makeBilling();
  const { core } = await makeApi({ billing, nodeTypes });
  const app = await buildApp(core, billing, {}, (await makeStartedAuth({ core })).app);
  apps.push(app);
  return app;
}

const VALID_GRAPH = {
  nodes: [
    { id: 'echo', type: 'example/echo@1.0.0', settings: { prefix: '> ' }, credentials: {} },
    {
      id: 'agent-1',
      type: 'swag/llm-agent@1.0.0',
      settings: { name: 'Агент', role: 'роль' },
      credentials: {},
    },
  ],
  edges: [{ from: 'echo', to: 'agent-1', kind: 'flow' }],
  entry: 'echo',
  exit: 'agent-1',
};
// Ребро на несуществующий узел и недостижимый агент: два замечания в порядке 4.4.
const BROKEN_GRAPH = {
  ...VALID_GRAPH,
  edges: [{ from: 'echo', to: 'ghost', kind: 'flow' }],
};

const postSwarm = (app: FastifyInstance, payload: object, token = T.u1) =>
  app.inject({ method: 'POST', url: '/swarms', headers: bearer(token), payload });

describe('граф по HTTP', () => {
  it('AC-009-12: POST /swarms с графом — 201, агент графа agent-1 в роях', async () => {
    const app = await setup();
    const response = await postSwarm(app, {
      task: 'Задача',
      budgetMicroUsd: 1000000,
      graph: VALID_GRAPH,
    });
    expect(response.statusCode).toBe(201);
    expect(response.json<{ agents: Array<{ id: string }> }>().agents.map((a) => a.id)).toEqual([
      'agent-1',
    ]);
  });

  it('AC-009-13: POST /swarms с графом с замечаниями — 400 invalid_graph, issues в формате ApiError', async () => {
    const app = await setup();
    const response = await postSwarm(app, {
      task: 'Задача',
      budgetMicroUsd: 1000000,
      graph: BROKEN_GRAPH,
    });
    expect(response.statusCode).toBe(400);
    const error = response.json<{
      error: { code: string; issues: Array<{ path: string; message: string }> };
    }>().error;
    expect(error.code).toBe('invalid_graph');
    expect(error.issues.map((i) => [i.path, i.message.split(':')[0]])).toEqual([
      ['edges.0', 'edge_unknown_node'],
      ['nodes.1', 'unreachable'],
    ]);
  });

  it('AC-009-15: POST /graph-checks — 200 с полными GraphIssue; корректный граф — ok: true', async () => {
    const app = await setup();
    const valid = await app.inject({
      method: 'POST',
      url: '/graph-checks',
      headers: bearer(T.u1),
      payload: VALID_GRAPH,
    });
    expect(valid.statusCode).toBe(200);
    expect(valid.json()).toEqual({ ok: true, issues: [] });

    const broken = await app.inject({
      method: 'POST',
      url: '/graph-checks',
      headers: bearer(T.u1),
      payload: BROKEN_GRAPH,
    });
    expect(broken.statusCode).toBe(200);
    const result = broken.json<{
      ok: boolean;
      issues: Array<{ code: string; path: string; message: string }>;
    }>();
    expect(result.ok).toBe(false);
    expect(result.issues.map((i) => [i.code, i.path])).toEqual([
      ['edge_unknown_node', 'edges.0'],
      ['unreachable', 'nodes.1'],
    ]);
  });

  it('AC-009-15: POST /graph-checks — тело не ProcessGraph 400 validation_error; без swarm.create 403; без токена 401', async () => {
    const app = await setup();
    const malformed = await app.inject({
      method: 'POST',
      url: '/graph-checks',
      headers: bearer(T.u1),
      payload: { nodes: 'x' },
    });
    expect(malformed.statusCode).toBe(400);
    expect(malformed.json<{ error: { code: string } }>().error.code).toBe('validation_error');

    const supervisor = await app.inject({
      method: 'POST',
      url: '/graph-checks',
      headers: bearer(T.sup),
      payload: VALID_GRAPH,
    });
    expect(supervisor.statusCode).toBe(403);

    const anonymous = await app.inject({
      method: 'POST',
      url: '/graph-checks',
      payload: VALID_GRAPH,
    });
    expect(anonymous.statusCode).toBe(401);
  });
});
