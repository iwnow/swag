import {
  createOrchestratorCore,
  type SandboxProvider,
  type SandboxSpec,
} from '@swag/orchestrator-core';

export const TOKEN = 'fake-orchestrator-token-for-tests-000000';

export function makeCore(sandboxes: Map<string, SandboxSpec>) {
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
