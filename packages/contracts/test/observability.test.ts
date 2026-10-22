import { describe, expect, it } from 'vitest';
import { LogRecord, PlatformEventInput } from '../src/index.ts';

const TRACE = '4bf92f3577b34da6a3ce929d0e0e4736';
const event = (traceId?: unknown) => ({
  id: '0b6f6d2e-6a4c-4c3e-9f5e-333333333333',
  swarmId: '0b6f6d2e-6a4c-4c3e-9f5e-111111111111',
  ts: '2026-10-22T10:00:00.000Z',
  source: 'orchestrator',
  agentId: null,
  ...(traceId === undefined ? {} : { traceId }),
  type: 'swarm.started',
  data: {},
});

const record = {
  time: '2026-10-22T10:00:00.000Z',
  level: 'error',
  service: 'agent',
  msg: 'agent start failed',
  traceId: TRACE,
  spanId: '00f067aa0ba902b7',
  swarmId: '0b6f6d2e-6a4c-4c3e-9f5e-111111111111',
  agentId: 'agent-1',
  err: { type: 'Error', message: 'boom', stack: 'Error: boom', cause: 'ECONNREFUSED' },
};

describe('traceId и LogRecord', () => {
  it('AC-016-1: событие с traceId из 32 hex и с null проходит; нули, длина 31, заглавные и без поля — ошибка', () => {
    expect(PlatformEventInput.safeParse(event(TRACE)).success).toBe(true);
    expect(PlatformEventInput.safeParse(event(null)).success).toBe(true);
    expect(PlatformEventInput.safeParse(event('0'.repeat(32))).success).toBe(false);
    expect(PlatformEventInput.safeParse(event(TRACE.slice(1))).success).toBe(false);
    expect(PlatformEventInput.safeParse(event(TRACE.toUpperCase())).success).toBe(false);
    expect(PlatformEventInput.safeParse(event()).success).toBe(false);
  });

  it('AC-016-1: LogRecord с полями 4.2 и лишним req проходит; level 30 или без service — ошибка', () => {
    expect(LogRecord.safeParse({ ...record, req: { method: 'POST' } }).success).toBe(true);
    expect(LogRecord.safeParse({ ...record, level: 30 }).success).toBe(false);
    const { service: _service, ...withoutService } = record;
    expect(LogRecord.safeParse(withoutService).success).toBe(false);
  });
});
