import { describe, expect, it } from 'vitest';
import type { PlatformEventInput } from '@swag/contracts';
import { failureReasonText, formatNodeEvent, type NodeEvent } from '../src/index.ts';

const withEnvelope = (input: PlatformEventInput): NodeEvent =>
  ({
    ...input,
    id: '0b6f6d2e-6a4c-4c3e-9f5e-333333333333',
    seq: 5,
    swarmId: '0b6f6d2e-6a4c-4c3e-9f5e-111111111111',
    ts: '2026-11-03T10:00:00.000Z',
    source: 'orchestrator',
    agentId: null,
    traceId: null,
  }) as NodeEvent;

describe('formatNodeEvent', () => {
  it('AC-009-25: три вида node.* и node_failed по 4.10', () => {
    const started = withEnvelope({
      type: 'node.started',
      data: { nodeId: 'echo', type: 'echo@1.0.0' },
    } as PlatformEventInput);
    const completed = withEnvelope({
      type: 'node.completed',
      data: { nodeId: 'echo', durationMs: 1200 },
    } as PlatformEventInput);
    const failed = withEnvelope({
      type: 'node.failed',
      data: { nodeId: 'echo', code: 'timeout', message: 'таймаут', durationMs: 30000 },
    } as PlatformEventInput);

    expect(formatNodeEvent(started)).toBe('echo запущен');
    expect(formatNodeEvent(completed)).toBe('echo завершён за 1200 мс');
    expect(formatNodeEvent(failed)).toBe('echo: ошибка timeout — таймаут');
    expect(failureReasonText('node_failed')).toBe('ошибка шага процесса');
  });
});
