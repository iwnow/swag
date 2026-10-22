import { describe, expect, it, vi } from 'vitest';
import { createApiCore, type OrchestratorClient } from '@swag/api-core';
import { createAgentCore, type AgentBus } from '@swag/agent-core';
import { createOrchestratorCore, type OrchestratorBus, type SandboxProvider, type SandboxSpec } from '@swag/orchestrator-core';
import { createMemorySwarmStore } from '@swag/adapter-memory';
import { ALL_EVENTS, ALL_INBOXES, eventsSubject, inboxSubject, type AgentId, type PlatformEventInput } from '@swag/contracts';

// Сквозной тест без Docker и сети (AC-001-20): api-core, orchestrator-core и три agent-core
// в одном процессе; шина — в памяти; песочница — фейк, который поднимает agent-core в процессе.

type Handler = (raw: unknown) => void;

// Минимальная шина в памяти с wildcard-подписками NATS ('*' — один токен).
function createHub() {
  const subs: { pattern: string[]; handler: Handler }[] = [];
  const matches = (pattern: string[], subject: string[]) =>
    pattern.length === subject.length && pattern.every((p, i) => p === '*' || p === subject[i]);
  return {
    subscribe(pattern: string, handler: Handler): () => void {
      const entry = { pattern: pattern.split('.'), handler };
      subs.push(entry);
      return () => {
        const index = subs.indexOf(entry);
        if (index >= 0) subs.splice(index, 1);
      };
    },
    publish(subject: string, value: unknown): void {
      const tokens = subject.split('.');
      for (const sub of [...subs]) {
        if (matches(sub.pattern, tokens)) setTimeout(() => sub.handler(value), 0);
      }
    },
  };
}

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

describe('сквозной скелет без Docker', () => {
  it('AC-001-20: createSwarm с тремя агентами — completed, результат эстафеты, песочниц нет, seq без пропусков', async () => {
    const hub = createHub();
    let counter = 0;
    const ids = { uuid: () => uuid(++counter) };
    const clock = { now: () => '2026-10-22T10:00:00.000Z' };
    const logs: string[] = [];
    const log = { warn: (message: string) => logs.push(message) };

    // песочница: на create поднимает agent-core в процессе, на remove — отписывает
    const running = new Map<string, () => void>();
    const sandboxes = new Map<string, SandboxSpec>();
    const sandboxProvider: SandboxProvider = {
      create: async (spec) => {
        const sandboxId = `sb-${++counter}`;
        sandboxes.set(sandboxId, spec);
        const env = spec.env;
        const agentBus: AgentBus = {
          subscribe: async (subject, handler) => {
            running.set(sandboxId, hub.subscribe(subject, handler));
          },
          publishEvent: async (event) => hub.publish(eventsSubject(event.swarmId), event),
          publishMessage: async (message) => hub.publish(inboxSubject(message.swarmId, message.to), message),
        };
        const agent = createAgentCore({
          version: 'test',
          bus: agentBus,
          clock,
          ids,
          timers: { setTimeout: (fn, ms) => setTimeout(fn, ms) },
          log,
          config: {
            swarmId: env['SWARM_ID'] as string,
            agentId: env['AGENT_ID'] as AgentId,
            agentName: env['AGENT_NAME'] as string,
            agentRole: env['AGENT_ROLE'] as string,
            agentNext: env['AGENT_NEXT'] ? (env['AGENT_NEXT'] as AgentId) : null,
            stepDelayMs: 0,
          },
        });
        await agent.start();
        return { sandboxId };
      },
      remove: async (sandboxId) => {
        running.get(sandboxId)?.();
        running.delete(sandboxId);
        sandboxes.delete(sandboxId);
      },
      list: async (match) =>
        [...sandboxes.entries()]
          .filter(([, spec]) => Object.entries(match).every(([k, v]) => (v === true ? k in spec.metadata : spec.metadata[k] === v)))
          .map(([id]) => id),
    };

    const orchestratorBus: OrchestratorBus = {
      publishEvent: async (event: PlatformEventInput) => hub.publish(eventsSubject(event.swarmId), event),
      publishMessage: async (message) => hub.publish(inboxSubject(message.swarmId, message.to), message),
    };
    const orchestrator = createOrchestratorCore({
      version: 'test',
      sandboxes: sandboxProvider,
      bus: orchestratorBus,
      clock,
      timers: { setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (id) => clearTimeout(id as ReturnType<typeof setTimeout>) },
      ids,
      log,
      agent: { template: 'swag-agent:test', stepDelayMs: 0 },
      timeouts: { agentStartMs: 5000, swarmMs: 60000 },
    });
    hub.subscribe(ALL_EVENTS, (raw) => void orchestrator.handleEvent(raw));

    const orchestratorClient: OrchestratorClient = {
      launch: async (launch) => {
        const result = await orchestrator.launch(launch);
        if (!result.ok) throw new Error(result.error.message);
      },
      stop: async (swarmId) => {
        const result = await orchestrator.stop(swarmId);
        if (!result.ok) throw new Error(result.error.message);
      },
    };
    const api = createApiCore({
      version: 'test',
      store: createMemorySwarmStore(),
      orchestrator: orchestratorClient,
      clock,
      ids,
      log,
      limits: { maxActiveSwarms: 3 },
    });
    hub.subscribe(ALL_EVENTS, (raw) => api.ingestEvent(raw));
    hub.subscribe(ALL_INBOXES, (raw) => api.ingestMessage(raw));

    const created = await api.createSwarm({
      task: 'T',
      agents: [
        { name: 'A', role: 'r1' },
        { name: 'B', role: 'r2' },
        { name: 'C', role: 'r3' },
      ],
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const id = created.value.id;

    await vi.waitFor(() => expect(api.getSwarm(id)).toMatchObject({ ok: true, value: { status: 'completed' } }), {
      timeout: 5000,
    });

    const view = api.getSwarm(id);
    if (!view.ok) throw new Error('рой не найден');
    expect(view.value.result).toBe('T\nA (r1): ok\nB (r2): ok\nC (r3): ok');
    expect(view.value.agents.every((a) => a.status === 'stopped' || a.status === 'done')).toBe(true);
    expect(view.value.edges.map((e) => e.messages)).toEqual([1, 1]);
    expect(sandboxes.size).toBe(0);
    const events = api.getEvents(id, 0);
    if (!events.ok) throw new Error('нет событий');
    expect(events.value.map((e) => e.seq)).toEqual(events.value.map((_, i) => i + 1));
    expect(logs).toEqual([]);
  });
});
