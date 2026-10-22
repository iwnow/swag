import { describe, expect, it, vi } from 'vitest';
import type { BusMessage, PlatformEventInput } from '@swag/contracts';
import { createAgentCore, type AgentBus, type AgentConfigCore } from '../src/index.ts';

const SWARM = '0b6f6d2e-6a4c-4c3e-9f5e-111111111111';
const MSG = '0b6f6d2e-6a4c-4c3e-9f5e-333333333333';

function fakeBus() {
  const events: PlatformEventInput[] = [];
  const messages: BusMessage[] = [];
  const handlers = new Map<string, (raw: unknown) => void>();
  const bus: AgentBus = {
    subscribe: async (subject, handler) => {
      handlers.set(subject, handler);
    },
    publishEvent: async (event) => {
      events.push(event);
    },
    publishMessage: async (message) => {
      messages.push(message);
    },
  };
  return { bus, events, messages, handlers };
}

let counter = 0;
const config = (overrides: Partial<AgentConfigCore>): AgentConfigCore => ({
  swarmId: SWARM,
  agentId: 'agent-1',
  agentName: 'A',
  agentRole: 'r1',
  agentNext: 'agent-2',
  stepDelayMs: 0,
  ...overrides,
});

function setup(overrides: Partial<AgentConfigCore>) {
  const fake = fakeBus();
  const core = createAgentCore({
    version: 'test',
    bus: fake.bus,
    clock: { now: () => '2026-10-22T10:00:00.000Z' },
    ids: { uuid: () => `00000000-0000-4000-8000-${String(++counter).padStart(12, '0')}` },
    timers: { setTimeout: (fn) => setTimeout(fn, 0) },
    log: { warn: () => undefined },
    config: config(overrides),
  });
  return { core, ...fake };
}

const inbox = (text: string) => ({
  id: MSG,
  swarmId: SWARM,
  from: 'user',
  to: 'agent-1',
  text,
  ts: '2026-10-22T10:00:01.000Z',
});

describe('agent-core', () => {
  it('AC-000-16: info() возвращает ServiceInfo сервиса agent с версией из оболочки', () => {
    const { core } = setup({});
    expect(core.info()).toEqual({ service: 'agent', version: 'test' });
  });

  it('AC-001-19: agent.started, затем agent.working и сообщение следующему агенту с текстом эстафеты', async () => {
    const { core, events, messages, handlers } = setup({ agentNext: 'agent-2' });
    await core.start();
    expect(events.map((e) => e.type)).toEqual(['agent.started']);
    handlers.get(`swarm.${SWARM}.agent.agent-1.inbox`)?.(inbox('T'));
    await vi.waitFor(() => expect(messages).toHaveLength(1));
    expect(events.map((e) => e.type)).toEqual(['agent.started', 'agent.working']);
    expect(events[1]).toMatchObject({ type: 'agent.working', data: { messageId: MSG } });
    expect(messages[0]).toMatchObject({ from: 'agent-1', to: 'agent-2', text: 'T\nA (r1): ok', swarmId: SWARM });
  });

  it('AC-001-19: последний агент публикует agent.result вместо сообщения', async () => {
    const { core, events, messages, handlers } = setup({ agentNext: null, agentName: 'C', agentRole: 'r3' });
    await core.start();
    handlers.get(`swarm.${SWARM}.agent.agent-1.inbox`)?.(inbox('T'));
    await vi.waitFor(() => expect(events.some((e) => e.type === 'agent.result')).toBe(true));
    expect(messages).toHaveLength(0);
    expect(events.at(-1)).toMatchObject({ type: 'agent.result', agentId: 'agent-1', data: { text: 'T\nC (r3): ok' } });
  });
});
