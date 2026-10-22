import { describe, expect, it } from 'vitest';
import type { PlatformEvent, PlatformEventInput } from '@swag/contracts';
import { applyEvent, projectSwarm } from '../src/index.ts';

const SWARM = '0b6f6d2e-6a4c-4c3e-9f5e-111111111111';
const MSG = '0b6f6d2e-6a4c-4c3e-9f5e-222222222222';
const A1 = 'agent-1';
const A2 = 'agent-2';

let n = 0;
const ev = (input: PlatformEventInput): PlatformEvent => {
  n += 1;
  return { ...input, seq: n } as PlatformEvent;
};
const base = (
  agentId: 'agent-1' | 'agent-2' | null,
  source: 'api' | 'orchestrator' | 'agent' = 'agent',
) => ({
  id: `0b6f6d2e-6a4c-4c3e-9f5e-${String(900000000000 + n).padStart(12, '0')}`,
  swarmId: SWARM,
  ts: '2026-10-22T10:00:00.000Z',
  source,
  agentId,
});

// Последовательность из 4.4: два агента, цепочка agent-1 → agent-2.
function sequence(): PlatformEvent[] {
  n = 0;
  return [
    ev({
      ...base(null, 'api'),
      type: 'swarm.created',
      data: {
        task: 'T',
        agents: [
          { id: A1, name: 'A', role: 'r1' },
          { id: A2, name: 'B', role: 'r2' },
        ],
      },
    }),
    ev({ ...base(null, 'orchestrator'), type: 'swarm.started', data: {} }),
    ev({ ...base(A1), type: 'agent.started', data: {} }),
    ev({ ...base(A2), type: 'agent.started', data: {} }),
    ev({
      ...base(null, 'api'),
      type: 'bus.message',
      data: { messageId: MSG, from: 'user', to: A1, text: 'T' },
    }),
    ev({ ...base(A1), type: 'agent.working', data: { messageId: MSG } }),
    ev({
      ...base(A1),
      type: 'bus.message',
      data: { messageId: MSG, from: A1, to: A2, text: 'T\nA (r1): ok' },
    }),
    ev({ ...base(A2), type: 'agent.result', data: { text: 'R' } }),
    ev({ ...base(A1), type: 'agent.stopped', data: {} }),
    ev({ ...base(A2), type: 'agent.stopped', data: {} }),
    ev({ ...base(null, 'orchestrator'), type: 'swarm.completed', data: { result: 'R' } }),
  ];
}

describe('projectSwarm', () => {
  it('AC-001-2: статусы, счётчики, рёбра и результат соответствуют таблице 4.4', () => {
    const view = projectSwarm(sequence());
    expect(view.status).toBe('completed');
    expect(view.result).toBe('R');
    expect(view.failure).toBeNull();
    expect(view.lastSeq).toBe(11);
    expect(view.createdAt).toBe('2026-10-22T10:00:00.000Z');
    expect(view.edges).toEqual([{ from: A1, to: A2, messages: 1 }]);
    const [a1, a2] = view.agents;
    expect(a1).toMatchObject({ id: A1, status: 'stopped', messagesIn: 1, messagesOut: 1 });
    expect(a2).toMatchObject({ id: A2, status: 'done', messagesIn: 1, messagesOut: 0 });
  });

  it('AC-001-2: событие с повторным seq не меняет состояние', () => {
    const events = sequence();
    const duplicate = {
      ...events[2]!,
      type: 'agent.working',
      data: { messageId: MSG },
    } as PlatformEvent;
    const before = projectSwarm(events);
    const after = applyEvent(before, { ...duplicate, seq: 3 } as PlatformEvent);
    expect(after).toBe(before);
  });

  it('AC-001-2: swarm.failed записывает причину и деталь', () => {
    n = 0;
    const created = ev({
      ...base(null, 'api'),
      type: 'swarm.created',
      data: { task: 'T', agents: [{ id: A1, name: 'A', role: 'r1' }] },
    });
    const failed = ev({
      ...base(null, 'api'),
      type: 'swarm.failed',
      data: { reason: 'orchestrator_unavailable', detail: 'connect refused' },
    });
    const view = projectSwarm([created, failed]);
    expect(view.status).toBe('failed');
    expect(view.failure).toEqual({ reason: 'orchestrator_unavailable', detail: 'connect refused' });
  });

  it('AC-001-2: событие до swarm.created — ошибка', () => {
    n = 0;
    const started = ev({ ...base(null, 'orchestrator'), type: 'swarm.started', data: {} });
    expect(() => applyEvent(null, started)).toThrow();
  });
});
