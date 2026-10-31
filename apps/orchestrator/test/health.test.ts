import { describe, expect, it } from 'vitest';
import type { SandboxSpec } from '@swag/orchestrator-core';
import { buildApp } from '../src/app.ts';
import { makeCore, TOKEN } from './support.ts';

describe('GET /health', () => {
  it('AC-000-5: 200 и тело по контракту 4.4', async () => {
    const app = buildApp(makeCore(new Map()), {}, { token: TOKEN });
    const response = await app.inject({ method: 'GET', url: '/health' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok', service: 'orchestrator', version: 'test' });
    await app.close();
  });

  it('AC-001-12: POST /swarms с лишним полем image — 400, песочницы не создаются', async () => {
    const sandboxes = new Map<string, SandboxSpec>();
    const app = buildApp(makeCore(sandboxes), {}, { token: TOKEN });
    const response = await app.inject({
      method: 'POST',
      url: '/swarms',
      headers: { authorization: `Bearer ${TOKEN}` },
      payload: {
        swarmId: '0b6f6d2e-6a4c-4c3e-9f5e-111111111111',
        task: 'T',
        agents: [{ id: 'agent-1', name: 'A', role: 'r' }],
        image: 'evil:latest',
      },
    });
    expect(response.statusCode).toBe(400);
    expect(sandboxes.size).toBe(0);
    await app.close();
  });
});
