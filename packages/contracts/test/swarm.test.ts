import { describe, expect, it } from 'vitest';
import { LlmSwarmRegistration, PlatformEventInput, SwarmCreateRequest } from '../src/index.ts';

const agent = (i: number, role = 'роль') => ({ name: `Агент ${i}`, role });
const request = (agents: unknown[], task = 'Задача') => ({ task, budgetMicroUsd: 500000, agents });
const SWARM = '0b6f6d2e-6a4c-4c3e-9f5e-111111111111';
const swarmFailed = (reason: string) => ({
  id: '0b6f6d2e-6a4c-4c3e-9f5e-333333333333',
  swarmId: SWARM,
  ts: '2026-10-29T10:00:00.000Z',
  agentId: null,
  traceId: null,
  source: 'api',
  type: 'swarm.failed',
  data: { reason },
});

describe('swarm.failed', () => {
  it('REQ-003-6: swarm.failed принимает причину api_restarted', () => {
    expect(PlatformEventInput.safeParse(swarmFailed('api_restarted')).success).toBe(true);
  });

  it('REQ-003-6: swarm.failed отклоняет неизвестную причину', () => {
    expect(PlatformEventInput.safeParse(swarmFailed('unknown_reason')).success).toBe(false);
  });
});

describe('SwarmCreateRequest', () => {
  it('AC-001-1: принимает запрос с 1 и с 8 агентами', () => {
    expect(SwarmCreateRequest.safeParse(request([agent(1)])).success).toBe(true);
    expect(
      SwarmCreateRequest.safeParse(request(Array.from({ length: 8 }, (_, i) => agent(i)))).success,
    ).toBe(true);
  });

  it('AC-001-1: отклоняет пустую задачу, 0 или 9 агентов с путём поля', () => {
    const empty = SwarmCreateRequest.safeParse(request([agent(1)], '   '));
    expect(empty.success).toBe(false);
    expect(empty.error?.issues[0]?.path).toEqual(['task']);

    const none = SwarmCreateRequest.safeParse(request([]));
    expect(none.success).toBe(false);
    expect(none.error?.issues[0]?.path).toEqual(['agents']);

    const nine = SwarmCreateRequest.safeParse(
      request(Array.from({ length: 9 }, (_, i) => agent(i))),
    );
    expect(nine.success).toBe(false);
    expect(nine.error?.issues[0]?.path).toEqual(['agents']);
  });

  it('AC-001-1: отклоняет роль длиннее 500 символов с путём agents.0.role', () => {
    const result = SwarmCreateRequest.safeParse(request([agent(1, 'я'.repeat(501))]));
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(['agents', 0, 'role']);
  });

  it('AC-001-1: отклоняет лишнее поле', () => {
    const result = SwarmCreateRequest.safeParse({ ...request([agent(1)]), image: 'x' });
    expect(result.success).toBe(false);
  });
});

describe('AC-004-1: бюджеты роя и агента в SwarmCreateRequest', () => {
  const withBudget = (budgetMicroUsd: unknown, agents: unknown[] = [agent(1)]) => ({
    task: 'Задача',
    budgetMicroUsd,
    agents,
  });

  it('AC-004-1: бюджет роя обязателен, целый, от 1 до 1_000_000_000', () => {
    const { budgetMicroUsd: _, ...withoutBudget } = withBudget(1);
    expect(SwarmCreateRequest.safeParse(withoutBudget).success).toBe(false);
    for (const value of [0, 1.5, 1_000_000_001]) {
      expect(SwarmCreateRequest.safeParse(withBudget(value)).success, String(value)).toBe(false);
    }
    expect(SwarmCreateRequest.safeParse(withBudget(500000)).success).toBe(true);
  });

  it('AC-004-1: бюджет агента 0 — ошибка', () => {
    const agents = [{ ...agent(1), budgetMicroUsd: 0 }];
    expect(SwarmCreateRequest.safeParse(withBudget(500000, agents)).success).toBe(false);
  });

  it('AC-004-1: агент без бюджета получает budgetMicroUsd null', () => {
    const result = SwarmCreateRequest.safeParse(withBudget(500000));
    expect(result.success).toBe(true);
    expect(result.data?.agents[0]?.budgetMicroUsd).toBe(null);
  });
});

describe('AC-004-3: события до 004 остаются валидными', () => {
  const envelope = {
    id: '0b6f6d2e-6a4c-4c3e-9f5e-444444444444',
    swarmId: SWARM,
    ts: '2026-10-29T10:00:00.000Z',
    agentId: null,
    traceId: null,
    source: 'api',
  };

  it('AC-004-3: swarm.created без бюджетов принимается, и с бюджетами тоже', () => {
    const agents = [{ name: 'Агент 1', role: 'роль', model: 'chat-small', id: 'agent-1' }];
    const before = { ...envelope, type: 'swarm.created', data: { task: 'Задача', agents } };
    expect(PlatformEventInput.safeParse(before).success).toBe(true);

    const after = {
      ...envelope,
      type: 'swarm.created',
      data: {
        task: 'Задача',
        budgetMicroUsd: 500000,
        agents: [{ ...agents[0], budgetMicroUsd: null }],
      },
    };
    expect(PlatformEventInput.safeParse(after).success).toBe(true);
  });

  it('AC-004-3: llm.call без charge принимается', () => {
    const llmCall = {
      ...envelope,
      source: 'llm-gateway',
      agentId: 'agent-1',
      type: 'llm.call',
      data: {
        callId: '0b6f6d2e-6a4c-4c3e-9f5e-555555555555',
        model: 'chat-small',
        stream: false,
        status: 'ok',
        usage: { promptTokens: 1, cachedPromptTokens: 0, completionTokens: 1 },
        costMicroUsd: 1,
        providerCostMicroUsd: null,
        latencyMs: 1,
      },
    };
    expect(PlatformEventInput.safeParse(llmCall).success).toBe(true);
  });

  it('swarm.failed принимает причины budget_exceeded и gateway_unavailable', () => {
    expect(PlatformEventInput.safeParse(swarmFailed('budget_exceeded')).success).toBe(true);
    expect(PlatformEventInput.safeParse(swarmFailed('gateway_unavailable')).success).toBe(true);
  });
});

describe('LlmSwarmRegistration', () => {
  const agents = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      agentId: `agent-${i + 1}`,
      model: 'chat-small',
      budgetMicroUsd: null,
    }));
  const registration = (overrides: object = {}) => ({
    swarmId: SWARM,
    budgetMicroUsd: 500000,
    expiresAt: '2026-10-29T10:05:00.000Z',
    agents: agents(2),
    ...overrides,
  });

  it('регистрация с 1 и с 8 агентами проходит, expiresAt null допустим', () => {
    expect(LlmSwarmRegistration.safeParse(registration({ agents: agents(1) })).success).toBe(true);
    expect(LlmSwarmRegistration.safeParse(registration({ agents: agents(8) })).success).toBe(true);
    expect(LlmSwarmRegistration.safeParse(registration({ expiresAt: null })).success).toBe(true);
  });

  it('регистрация без агентов, с 9 агентами и с неверным agentId отклоняется', () => {
    expect(LlmSwarmRegistration.safeParse(registration({ agents: [] })).success).toBe(false);
    expect(LlmSwarmRegistration.safeParse(registration({ agents: agents(9) })).success).toBe(false);
    const badId = [{ agentId: 'agent-0', model: 'chat-small', budgetMicroUsd: null }];
    expect(LlmSwarmRegistration.safeParse(registration({ agents: badId })).success).toBe(false);
  });
});

describe('AC-031: лимит ответа агента в SwarmCreateRequest', () => {
  const withMaxTokens = (maxTokens: unknown, agentMaxTokens: unknown = null) => ({
    task: 'Задача',
    budgetMicroUsd: 500000,
    maxTokens,
    agents: [{ ...agent(1), maxTokens: agentMaxTokens }],
  });

  it('AC-031-1: maxTokens 16384 и null у роя и агента проходят', () => {
    expect(SwarmCreateRequest.safeParse(withMaxTokens(16384, 16384)).success).toBe(true);
    expect(SwarmCreateRequest.safeParse(withMaxTokens(null, null)).success).toBe(true);
  });

  it('AC-031-1: отсутствие maxTokens даёт null у роя и у агента', () => {
    const result = SwarmCreateRequest.safeParse(request([agent(1)]));
    expect(result.success).toBe(true);
    expect(result.data?.maxTokens).toBe(null);
    expect(result.data?.agents[0]?.maxTokens).toBe(null);
  });

  it('AC-031-1: отклоняет 0, 1.5, строку и 1_000_001 у роя и у агента', () => {
    for (const value of [0, 1.5, '100', 1_000_001]) {
      expect(SwarmCreateRequest.safeParse(withMaxTokens(value)).success, String(value)).toBe(false);
      expect(SwarmCreateRequest.safeParse(withMaxTokens(null, value)).success, String(value)).toBe(
        false,
      );
    }
  });
});

describe('AC-031-6: событие swarm.created без maxTokens', () => {
  const envelope = {
    id: '0b6f6d2e-6a4c-4c3e-9f5e-666666666666',
    swarmId: SWARM,
    ts: '2026-10-30T10:00:00.000Z',
    agentId: null,
    traceId: null,
    source: 'api',
    type: 'swarm.created',
  };
  const agents = [{ name: 'Агент 1', role: 'роль', model: 'chat-small', id: 'agent-1' }];

  it('AC-031-6: swarm.created без maxTokens у роя и агентов разбирается', () => {
    const data = { task: 'Задача', budgetMicroUsd: 500000, agents };
    expect(PlatformEventInput.safeParse({ ...envelope, data }).success).toBe(true);
  });

  it('AC-031-6: swarm.created с maxTokens у роя и агента разбирается', () => {
    const data = {
      task: 'Задача',
      budgetMicroUsd: 500000,
      maxTokens: 4096,
      agents: [{ ...agents[0], maxTokens: null }],
    };
    expect(PlatformEventInput.safeParse({ ...envelope, data }).success).toBe(true);
  });
});
