import { describe, expect, it } from 'vitest';
import {
  createOrchestratorCore,
  type SandboxProvider,
  type SandboxSpec,
} from '@swag/orchestrator-core';
import { buildApp } from '../src/app.ts';

function makeCore(sandboxes: Map<string, SandboxSpec>) {
  const provider: SandboxProvider = {
    create: async (spec) => {
      const sandboxId = `sb-${sandboxes.size + 1}`;
      sandboxes.set(sandboxId, spec);
      return { sandboxId };
    },
    remove: async (id) => {
      sandboxes.delete(id);
    },
    list: async () => [...sandboxes.keys()],
  };
  return createOrchestratorCore({
    version: 'test',
    sandboxes: provider,
    bus: { publishEvent: async () => undefined, publishMessage: async () => undefined },
    clock: { now: () => '2026-10-22T10:00:00.000Z' },
    timers: { setTimeout: () => 0, clearTimeout: () => undefined },
    ids: { uuid: () => '00000000-0000-4000-8000-000000000001' },
    llmSwarms: { register: async () => undefined, close: async () => undefined },
    log: {
      debug: () => undefined,
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
    },
    trace: { currentTraceId: () => null },
    agent: {
      template: 'swag-agent:test',
      maxSteps: 20,
      maxTokens: 2048,
      llmGatewayToken: 'fake-gateway-token-for-tests-000000',
      flushTimeoutMs: 2000,
    },
    timeouts: { agentStartMs: 30000, swarmMs: 300000 },
  });
}

describe('GET /health', () => {
  it('AC-000-5: 200 и тело по контракту 4.4', async () => {
    const app = buildApp(makeCore(new Map()));
    const response = await app.inject({ method: 'GET', url: '/health' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok', service: 'orchestrator', version: 'test' });
    await app.close();
  });

  it('AC-001-12: POST /swarms с лишним полем image — 400, песочницы не создаются', async () => {
    const sandboxes = new Map<string, SandboxSpec>();
    const app = buildApp(makeCore(sandboxes));
    const response = await app.inject({
      method: 'POST',
      url: '/swarms',
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
