import { describe, expect, it } from 'vitest';
import type { PlatformEvent, PlatformEventInput } from '@swag/contracts';
import { applyEvent, projectSwarm, type SwarmView } from '../src/index.ts';

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
  traceId: null,
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
          { id: A1, name: 'A', role: 'r1', model: 'chat-small' },
          { id: A2, name: 'B', role: 'r2', model: 'chat-small' },
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
    expect(a1).toMatchObject({
      id: A1,
      model: 'chat-small',
      status: 'stopped',
      messagesIn: 1,
      messagesOut: 1,
      steps: 0,
    });
    expect(a2).toMatchObject({ id: A2, status: 'done', messagesIn: 1, messagesOut: 0, steps: 0 });
  });

  it('AC-001-2: при swarm.created рёбер нет, цепочка не строится', () => {
    const view = projectSwarm(sequence().slice(0, 1));
    expect(view.edges).toEqual([]);
    expect(view.agents.map((a) => a.status)).toEqual(['starting', 'starting']);
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
      data: { task: 'T', agents: [{ id: A1, name: 'A', role: 'r1', model: 'chat-small' }] },
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

describe('projectSwarm, правила 022 (4.6)', () => {
  it('AC-022-2: steps, рёбра по фактическим сообщениям, bus.message не меняет статус, idle по 4.6', () => {
    n = 0;
    const created = ev({
      ...base(null, 'api'),
      type: 'swarm.created',
      data: {
        task: 'T',
        agents: [
          { id: A1, name: 'A', role: 'r1', model: 'chat-small' },
          { id: A2, name: 'B', role: 'r2', model: 'chat-large' },
        ],
      },
    });
    const working = ev({ ...base(A1), type: 'agent.working', data: { messageId: MSG } });
    const step1 = ev({
      ...base(A1),
      type: 'agent.step',
      data: {
        messageId: MSG,
        stepIndex: 1,
        text: null,
        toolCalls: [{ id: 'c1', name: 'send_message' }],
      },
    });
    const step2 = ev({
      ...base(A1),
      type: 'agent.step',
      data: { messageId: MSG, stepIndex: 2, text: 'done', toolCalls: [] },
    });
    const fromA2 = ev({
      ...base(A2),
      type: 'bus.message',
      data: { messageId: MSG, from: A2, to: A1, text: 'R2' },
    });
    const toA2 = ev({
      ...base(A1),
      type: 'bus.message',
      data: { messageId: MSG, from: A1, to: A2, text: 'go' },
    });
    const idle = ev({ ...base(A1), type: 'agent.idle', data: { messageId: MSG } });

    const busy = projectSwarm([created, working, step1, step2, fromA2, toA2]);
    expect(busy.agents[0]).toMatchObject({
      status: 'working',
      steps: 2,
      messagesIn: 1,
      messagesOut: 1,
    });
    expect(busy.agents[1]).toMatchObject({
      status: 'starting',
      model: 'chat-large',
      messagesIn: 1,
      messagesOut: 1,
    });
    expect(busy.edges).toEqual([
      { from: A2, to: A1, messages: 1 },
      { from: A1, to: A2, messages: 1 },
    ]);

    const idled = applyEvent(busy, idle);
    expect(idled.agents[0]).toMatchObject({ status: 'idle', steps: 2 });
  });

  it('AC-022-2: agent.idle после agent.result не меняет статус done', () => {
    n = 0;
    const created = ev({
      ...base(null, 'api'),
      type: 'swarm.created',
      data: { task: 'T', agents: [{ id: A1, name: 'A', role: 'r1', model: 'chat-small' }] },
    });
    const result = ev({ ...base(A1), type: 'agent.result', data: { text: 'R' } });
    const idle = ev({ ...base(A1), type: 'agent.idle', data: { messageId: MSG } });
    const view = projectSwarm([created, result, idle]);
    expect(view.agents[0]).toMatchObject({ status: 'done' });
  });
});

describe('projectSwarm, итоговый статус роя (003, 4.3)', () => {
  it('AC-003-7: поздние swarm.stopped и agent.stopped двигают lastSeq, статус и failure не меняют', () => {
    n = 0;
    const created = ev({
      ...base(null, 'api'),
      type: 'swarm.created',
      data: { task: 'T', agents: [{ id: A1, name: 'A', role: 'r1', model: 'chat-small' }] },
    });
    const started = ev({ ...base(null, 'orchestrator'), type: 'swarm.started', data: {} });
    const agentStarted = ev({ ...base(A1), type: 'agent.started', data: {} });
    const failed = ev({
      ...base(null, 'api'),
      type: 'swarm.failed',
      data: { reason: 'api_restarted' },
    });
    const swarmStopped = ev({
      ...base(null, 'orchestrator'),
      type: 'swarm.stopped',
      data: { reason: 'user' },
    });
    const agentStopped = ev({ ...base(A1), type: 'agent.stopped', data: {} });

    const before = projectSwarm([created, started, agentStarted, failed]);
    const after = projectSwarm([
      created,
      started,
      agentStarted,
      failed,
      swarmStopped,
      agentStopped,
    ]);
    expect(after.lastSeq).toBe(agentStopped.seq);
    expect(after.status).toBe('failed');
    expect(after.failure).toEqual({ reason: 'api_restarted' });
    expect(after.agents[0]).toMatchObject({ status: before.agents[0]?.status });
    expect(after.agents[0]?.status).toBe('idle');
  });

  it('AC-003-7: swarm.completed после итогового статуса не меняет result', () => {
    n = 0;
    const created = ev({
      ...base(null, 'api'),
      type: 'swarm.created',
      data: { task: 'T', agents: [{ id: A1, name: 'A', role: 'r1', model: 'chat-small' }] },
    });
    const stopped = ev({
      ...base(null, 'orchestrator'),
      type: 'swarm.stopped',
      data: { reason: 'user' },
    });
    const completed = ev({
      ...base(null, 'orchestrator'),
      type: 'swarm.completed',
      data: { result: 'R' },
    });
    const view = projectSwarm([created, stopped, completed]);
    expect(view.status).toBe('stopped');
    expect(view.result).toBeNull();
    expect(view.lastSeq).toBe(completed.seq);
  });

  it('AC-003-7: повторный swarm.created после итогового статуса по-прежнему бросает', () => {
    n = 0;
    const created = ev({
      ...base(null, 'api'),
      type: 'swarm.created',
      data: { task: 'T', agents: [{ id: A1, name: 'A', role: 'r1', model: 'chat-small' }] },
    });
    const failed = ev({
      ...base(null, 'api'),
      type: 'swarm.failed',
      data: { reason: 'api_restarted' },
    });
    const again = ev({
      ...base(null, 'api'),
      type: 'swarm.created',
      data: { task: 'T', agents: [{ id: A1, name: 'A', role: 'r1', model: 'chat-small' }] },
    });
    const view = projectSwarm([created, failed]);
    expect(() => applyEvent(view, again)).toThrow('повторный swarm.created');
  });
});

// Вызов модели агента: проекции важны только charge и costMicroUsd (004, 4.7).
const llmCall = (agentId: 'agent-1' | 'agent-2', data: Record<string, unknown>) =>
  ev({
    ...base(agentId),
    type: 'llm.call',
    data: {
      callId: '0b6f6d2e-6a4c-4c3e-9f5e-333333333333',
      model: 'chat-small',
      stream: false,
      status: 'ok',
      usage: null,
      costMicroUsd: null,
      providerCostMicroUsd: null,
      latencyMs: 1,
      ...data,
    },
  } as PlatformEventInput);

describe('projectSwarm — AC-004-26: деньги роя и агентов', () => {
  it('AC-004-26: spentMicroUsd роя и агентов — суммы charge; бюджеты из swarm.created', () => {
    n = 0;
    const events = [
      ev({
        ...base(null, 'api'),
        type: 'swarm.created',
        data: {
          task: 'T',
          budgetMicroUsd: 500000,
          agents: [
            { id: A1, name: 'A', role: 'r1', model: 'chat-small', budgetMicroUsd: 100000 },
            { id: A2, name: 'B', role: 'r2', model: 'chat-small', budgetMicroUsd: null },
          ],
        },
      }),
      llmCall(A1, { charge: { microUsd: 30000, basis: 'usage' } }),
      llmCall(A2, { charge: { microUsd: 20000, basis: 'usage' } }),
      llmCall(A1, { charge: { microUsd: 5000, basis: 'estimate' } }),
    ];
    const view = projectSwarm(events);
    expect(view.budgetMicroUsd).toBe(500000);
    expect(view.spentMicroUsd).toBe(55000);
    expect(view.agents[0]).toMatchObject({ budgetMicroUsd: 100000, spentMicroUsd: 35000 });
    expect(view.agents[1]).toMatchObject({ budgetMicroUsd: null, spentMicroUsd: 20000 });
  });

  it('AC-004-26: событие без charge прибавляет costMicroUsd, при null — 0', () => {
    n = 0;
    const view = projectSwarm([
      ev({
        ...base(null, 'api'),
        type: 'swarm.created',
        data: { task: 'T', agents: [{ id: A1, name: 'A', role: 'r1', model: 'chat-small' }] },
      }),
      llmCall(A1, { costMicroUsd: 7000 }),
      llmCall(A1, { costMicroUsd: null }),
    ]);
    expect(view.spentMicroUsd).toBe(7000);
    expect(view.agents[0]?.spentMicroUsd).toBe(7000);
  });

  it('AC-004-3: рой до 004 без бюджетов проецируется: budgetMicroUsd нет, spentMicroUsd = 0', () => {
    n = 0;
    const view = projectSwarm([
      ev({
        ...base(null, 'api'),
        type: 'swarm.created',
        data: { task: 'T', agents: [{ id: A1, name: 'A', role: 'r1', model: 'chat-small' }] },
      }),
    ]);
    expect(view).not.toHaveProperty('budgetMicroUsd');
    expect(view.spentMicroUsd).toBe(0);
    expect(view.agents[0]).not.toHaveProperty('budgetMicroUsd');
    expect(view.agents[0]?.spentMicroUsd).toBe(0);
  });

  it('AC-004-26: расход после итогового статуса учитывается, статус не меняется', () => {
    n = 0;
    const view = projectSwarm([
      ev({
        ...base(null, 'api'),
        type: 'swarm.created',
        data: {
          task: 'T',
          budgetMicroUsd: 1000,
          agents: [{ id: A1, name: 'A', role: 'r1', model: 'chat-small' }],
        },
      }),
      ev({ ...base(null, 'api'), type: 'swarm.failed', data: { reason: 'api_restarted' } }),
      llmCall(A1, { charge: { microUsd: 400, basis: 'usage' } }),
    ]);
    expect(view.status).toBe('failed');
    expect(view.spentMicroUsd).toBe(400);
  });
});

describe('applyEvent — AC-004-3: проекция, сохранённая до 004', () => {
  it('AC-004-3: без полей расхода llm.call даёт число, не NaN', () => {
    n = 0;
    const view = projectSwarm([
      ev({
        ...base(null, 'api'),
        type: 'swarm.created',
        data: { task: 'T', agents: [{ id: A1, name: 'A', role: 'r1', model: 'chat-small' }] },
      }),
    ]);
    const stored = JSON.parse(JSON.stringify(view)) as Record<string, unknown>;
    delete stored['spentMicroUsd'];
    const next = applyEvent(stored as unknown as SwarmView, llmCall(A1, { costMicroUsd: 300 }));
    expect(next.spentMicroUsd).toBe(300);
    expect(next.agents[0]?.spentMicroUsd).toBe(300);
  });
});
