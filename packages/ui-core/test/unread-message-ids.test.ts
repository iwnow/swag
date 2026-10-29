import { describe, expect, it } from 'vitest';
import type { PlatformEvent, PlatformEventInput, SwarmStatus } from '@swag/contracts';
import { unreadMessageIds } from '../src/index.ts';

const SWARM = '0b6f6d2e-6a4c-4c3e-9f5e-111111111111';
const MSG_A = '0b6f6d2e-6a4c-4c3e-9f5e-222222222221';
const MSG_B = '0b6f6d2e-6a4c-4c3e-9f5e-222222222222';
const EV_A = '0b6f6d2e-6a4c-4c3e-9f5e-333333333331';
const EV_B = '0b6f6d2e-6a4c-4c3e-9f5e-333333333332';
const EV_W = '0b6f6d2e-6a4c-4c3e-9f5e-333333333333';

const withId = (id: string, input: PlatformEventInput, seq: number): PlatformEvent =>
  ({
    ...input,
    id,
    seq,
    swarmId: SWARM,
    ts: '2026-10-29T10:00:00.000Z',
    source: 'agent',
    agentId: 'agent-1',
    traceId: null,
  }) as PlatformEvent;

const feed: PlatformEvent[] = [
  withId(
    EV_A,
    {
      type: 'bus.message',
      data: { messageId: MSG_A, from: 'user', to: 'agent-1', text: 'A' },
    } as PlatformEventInput,
    1,
  ),
  withId(
    EV_B,
    {
      type: 'bus.message',
      data: { messageId: MSG_B, from: 'agent-2', to: 'agent-1', text: 'B' },
    } as PlatformEventInput,
    2,
  ),
  withId(EV_W, { type: 'agent.working', data: { messageId: MSG_A } } as PlatformEventInput, 3),
];

describe('unreadMessageIds', () => {
  it.each<SwarmStatus>(['completed', 'failed', 'stopped'])(
    'AC-030-7: в конечном статусе %s непрочитано только B',
    (status) => {
      expect(unreadMessageIds(feed, status)).toEqual(new Set([EV_B]));
    },
  );

  it('AC-030-7: пока рой работает, непрочитанного нет', () => {
    expect(unreadMessageIds(feed, 'running')).toEqual(new Set());
  });
});
