import { describe, expect, it } from 'vitest';
import { ENTRY_AGENT_ID, PlatformEventInput, SwarmCreateRequest } from '../src/index.ts';

const SWARM = '0b6f6d2e-6a4c-4c3e-9f5e-111111111111';
const MSG = '0b6f6d2e-6a4c-4c3e-9f5e-222222222222';
const base = {
  id: '0b6f6d2e-6a4c-4c3e-9f5e-333333333333',
  swarmId: SWARM,
  ts: '2026-10-28T10:00:00.000Z',
  agentId: 'agent-1',
  traceId: null,
};
const request = (agent: Record<string, unknown>) => ({ task: 'Задача', agents: [agent] });
const agent = { name: 'Агент', role: 'роль' };

describe('контракты цикла агента (022, 4.1)', () => {
  it('AC-022-1: агент без model получает chat-small', () => {
    const result = SwarmCreateRequest.parse(request(agent));
    expect(result.agents[0]?.model).toBe('chat-small');
  });

  it('AC-022-1: model chat-large проходит', () => {
    expect(SwarmCreateRequest.safeParse(request({ ...agent, model: 'chat-large' })).success).toBe(
      true,
    );
  });

  it('AC-022-1: model gpt-4 отклоняется с путём agents.0.model', () => {
    const result = SwarmCreateRequest.safeParse(request({ ...agent, model: 'gpt-4' }));
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(['agents', 0, 'model']);
  });

  it('AC-022-1: agent.step проходит PlatformEventInput', () => {
    const event = {
      ...base,
      source: 'agent',
      type: 'agent.step',
      data: {
        messageId: MSG,
        stepIndex: 1,
        text: null,
        toolCalls: [{ id: 'call-1', name: 'finish' }],
      },
    };
    expect(PlatformEventInput.safeParse(event).success).toBe(true);
  });

  it('AC-022-1: agent.idle проходит PlatformEventInput', () => {
    const event = { ...base, source: 'agent', type: 'agent.idle', data: { messageId: MSG } };
    expect(PlatformEventInput.safeParse(event).success).toBe(true);
  });

  it('AC-022-1: agent.failed от агента (source agent) проходит PlatformEventInput', () => {
    const event = {
      ...base,
      source: 'agent',
      type: 'agent.failed',
      data: { reason: 'max_steps' },
    };
    expect(PlatformEventInput.safeParse(event).success).toBe(true);
  });

  it('AC-022-1: swarm.failed с agent_failed проходит PlatformEventInput', () => {
    const event = {
      ...base,
      agentId: null,
      source: 'orchestrator',
      type: 'swarm.failed',
      data: { reason: 'agent_failed', detail: 'agent-2: model_error:upstream_error' },
    };
    expect(PlatformEventInput.safeParse(event).success).toBe(true);
  });

  it('AC-022-1: ENTRY_AGENT_ID равен agent-1', () => {
    expect(ENTRY_AGENT_ID).toBe('agent-1');
  });
});
