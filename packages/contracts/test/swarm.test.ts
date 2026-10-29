import { describe, expect, it } from 'vitest';
import { PlatformEventInput, SwarmCreateRequest } from '../src/index.ts';

const agent = (i: number, role = 'роль') => ({ name: `Агент ${i}`, role });
const request = (agents: unknown[], task = 'Задача') => ({ task, agents });
const SWARM = '0b6f6d2e-6a4c-4c3e-9f5e-111111111111';
const swarmFailed = (reason: string) => ({
  id: '0b6f6d2e-6a4c-4c3e-9f5e-333333333333',
  swarmId: SWARM,
  ts: '2026-10-29T10:00:00.000Z',
  agentId: null,
  traceId: null,
  source: 'orchestrator',
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
