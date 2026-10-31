import { describe, expect, it } from 'vitest';
import type { SandboxSpec } from '@swag/orchestrator-core';
import { buildApp } from '../src/app.ts';
import { makeCore, TOKEN } from './support.ts';

const SWARM_ID = '0b6f6d2e-6a4c-4c3e-9f5e-222222222222';
const LAUNCH = {
  swarmId: SWARM_ID,
  task: 'T',
  budgetMicroUsd: 1000000,
  maxTokens: null,
  agents: [
    {
      id: 'agent-1',
      name: 'A',
      role: 'r',
      model: 'chat-small',
      budgetMicroUsd: null,
      maxTokens: null,
    },
  ],
};

function setup() {
  const sandboxes = new Map<string, SandboxSpec>();
  const app = buildApp(makeCore(sandboxes), {}, { token: TOKEN });
  return { app, sandboxes };
}

describe('токен оркестратора (спека 024, 4.13)', () => {
  it('AC-024-22: POST /swarms без токена и с неверным — 401, рой не запускается', async () => {
    const { app, sandboxes } = setup();
    const missing = await app.inject({ method: 'POST', url: '/swarms', payload: LAUNCH });
    const wrong = await app.inject({
      method: 'POST',
      url: '/swarms',
      headers: { authorization: 'Bearer wrong-token' },
      payload: LAUNCH,
    });
    const notBearer = await app.inject({
      method: 'POST',
      url: '/swarms',
      headers: { authorization: `Token ${TOKEN}` },
      payload: LAUNCH,
    });
    expect(missing.statusCode).toBe(401);
    expect(missing.json()).toEqual({
      error: { code: 'unauthorized', message: 'Invalid orchestrator token' },
    });
    expect(wrong.statusCode).toBe(401);
    expect(notBearer.statusCode).toBe(401);
    expect(sandboxes.size).toBe(0);
    await app.close();
  });

  it('AC-024-22: POST /swarms/:id/stop без токена и с неверным — 401, рой не останавливается', async () => {
    const { app, sandboxes } = setup();
    const launched = await app.inject({
      method: 'POST',
      url: '/swarms',
      headers: { authorization: `Bearer ${TOKEN}` },
      payload: LAUNCH,
    });
    expect(launched.statusCode).toBe(202);
    expect(sandboxes.size).toBe(1);

    const missing = await app.inject({ method: 'POST', url: `/swarms/${SWARM_ID}/stop` });
    const wrong = await app.inject({
      method: 'POST',
      url: `/swarms/${SWARM_ID}/stop`,
      headers: { authorization: 'Bearer wrong-token' },
    });
    expect(missing.statusCode).toBe(401);
    expect(wrong.statusCode).toBe(401);
    expect(sandboxes.size).toBe(1);
    await app.close();
  });

  it('AC-024-22: с верным токеном POST /swarms — 202, POST /swarms/:id/stop — 202, для чужого id — 404', async () => {
    const { app, sandboxes } = setup();
    const authorization = `Bearer ${TOKEN}`;
    const launched = await app.inject({
      method: 'POST',
      url: '/swarms',
      headers: { authorization },
      payload: LAUNCH,
    });
    expect(launched.statusCode).toBe(202);
    expect(sandboxes.size).toBe(1);

    const stopped = await app.inject({
      method: 'POST',
      url: `/swarms/${SWARM_ID}/stop`,
      headers: { authorization },
    });
    expect(stopped.statusCode).toBe(202);

    const unknown = await app.inject({
      method: 'POST',
      url: '/swarms/0b6f6d2e-6a4c-4c3e-9f5e-333333333333/stop',
      headers: { authorization },
    });
    expect(unknown.statusCode).toBe(404);
    await app.close();
  });

  it('AC-024-22: GET /health без токена — 200', async () => {
    const { app } = setup();
    const response = await app.inject({ method: 'GET', url: '/health' });
    expect(response.statusCode).toBe(200);
    await app.close();
  });
});
