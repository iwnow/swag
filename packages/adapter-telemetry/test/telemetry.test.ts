import { afterEach, describe, expect, it } from 'vitest';
import { LogRecord } from '@swag/contracts';
import { createMemoryExporters, startTelemetry, type Telemetry } from '../src/index.ts';

const TRACE = '4bf92f3577b34da6a3ce929d0e0e4736';
const PARENT = `00-${TRACE}-00f067aa0ba902b7-01`;
const SWARM = '0b6f6d2e-6a4c-4c3e-9f5e-111111111111';

let current: Telemetry | null = null;
afterEach(async () => {
  await current?.shutdown();
  current = null;
});

function start(overrides: Partial<Parameters<typeof startTelemetry>[0]> = {}) {
  const lines: string[] = [];
  const telemetry = startTelemetry({
    service: 'agent',
    version: 'test',
    otlpEndpoint: null,
    logLevel: 'info',
    flushTimeoutMs: 500,
    stdout: (line) => lines.push(line),
    ...overrides,
  });
  current = telemetry;
  return { telemetry, lines };
}

describe('adapter-telemetry: логгер', () => {
  it('AC-016-2: каждая строка — LogRecord; вне спана без traceId, в спане traceId и spanId; err с cause; ниже уровня не выводится', () => {
    const { telemetry, lines } = start();
    const { logger } = telemetry;

    logger.info('outside');
    let active: { traceId: string | null } = { traceId: null };
    telemetry.inSpan('work', {}, () => {
      active = { traceId: telemetry.trace.currentTraceId() };
      const error = new Error('boom', { cause: new Error('ECONNREFUSED') });
      logger.error('failed', { swarmId: SWARM, agentId: 'agent-1', err: error });
    });
    logger.debug('hidden');

    expect(lines).toHaveLength(2);
    const records = lines.map((line) => LogRecord.parse(JSON.parse(line)));
    const [outside, inside] = records;
    expect(outside).toMatchObject({ level: 'info', service: 'agent', msg: 'outside' });
    expect(outside?.traceId).toBeUndefined();
    expect(outside?.spanId).toBeUndefined();
    expect(inside).toMatchObject({
      level: 'error',
      msg: 'failed',
      swarmId: SWARM,
      agentId: 'agent-1',
      traceId: active.traceId,
    });
    expect(inside?.spanId).toMatch(/^[0-9a-f]{16}$/);
    expect(inside?.err).toMatchObject({ type: 'Error', message: 'boom', cause: 'ECONNREFUSED' });
    expect(inside?.err?.stack).toContain('boom');
    for (const line of lines) {
      const raw = JSON.parse(line) as Record<string, unknown>;
      expect(raw).not.toHaveProperty('pid');
      expect(raw).not.toHaveProperty('hostname');
    }
  });

  it('запись уходит в OTLP Logs с traceId спана и уровнем; без экспорта ничего не отправляется', () => {
    const memory = createMemoryExporters();
    const { telemetry } = start({ exporters: { logs: memory.logs } });
    telemetry.inSpan('work', { parent: PARENT }, () =>
      telemetry.logger.warn('event dropped', { swarmId: SWARM, reason: 'unknown_swarm' }),
    );
    expect(memory.logRecords).toHaveLength(1);
    const record = memory.logRecords[0];
    expect(record?.body).toBe('event dropped');
    expect(record?.severityText).toBe('warn');
    expect(record?.spanContext?.traceId).toBe(TRACE);
    expect(record?.attributes).toMatchObject({ swarmId: SWARM, reason: 'unknown_swarm' });
  });

  it('недоступный Collector: запись и shutdown не бросают, shutdown укладывается в flushTimeoutMs', async () => {
    const { telemetry, lines } = start({ otlpEndpoint: 'http://127.0.0.1:1', flushTimeoutMs: 300 });
    telemetry.inSpan('work', {}, () => telemetry.logger.info('hello'));
    const started = Date.now();
    await telemetry.shutdown();
    expect(Date.now() - started).toBeLessThan(1500);
    expect(lines.some((line) => line.includes('"hello"'))).toBe(true);
  });
});

describe('adapter-telemetry: контекст', () => {
  it('AC-016-3: parent из traceparent, невалидный и без него; currentTraceparent; setTimeout внутри спана', async () => {
    const { telemetry } = start();
    const { trace } = telemetry;

    const fromParent = telemetry.inSpan('a', { parent: PARENT }, () => ({
      traceId: trace.currentTraceId(),
      traceparent: telemetry.currentTraceparent(),
    }));
    expect(fromParent.traceId).toBe(TRACE);
    expect(fromParent.traceparent).toMatch(new RegExp(`^00-${TRACE}-[0-9a-f]{16}-01$`));

    const invalid = telemetry.inSpan('b', { parent: '00-zzz-bad-01' }, () =>
      trace.currentTraceId(),
    );
    const none = telemetry.inSpan('c', { parent: null }, () => trace.currentTraceId());
    const noParent = telemetry.inSpan('d', {}, () => trace.currentTraceId());
    for (const id of [invalid, none, noParent]) {
      expect(id).toMatch(/^[0-9a-f]{32}$/);
      expect(id).not.toBe('0'.repeat(32));
      expect(id).not.toBe(TRACE);
    }
    expect(trace.currentTraceId()).toBeNull();
    expect(telemetry.currentTraceparent()).toBeNull();

    const inTimer = await telemetry.inSpan(
      'e',
      { parent: PARENT },
      () =>
        new Promise<string | null>((resolve) => {
          setTimeout(() => resolve(trace.currentTraceId()), 5);
        }),
    );
    expect(inTimer).toBe(TRACE);
  });

  it('спан с ошибкой: статус ERROR, исключение пробрасывается; атрибуты и kind сохраняются', async () => {
    const memory = createMemoryExporters();
    const { telemetry } = start({ exporters: { spans: memory.spans } });
    await expect(
      telemetry.inSpan('fails', { kind: 'client', attributes: { 'swarm.id': SWARM } }, async () => {
        throw new Error('nope');
      }),
    ).rejects.toThrow('nope');
    const span = memory.finishedSpans.find((s) => s.name === 'fails');
    expect(span?.status.code).toBe(2);
    expect(span?.kind).toBe(2);
    expect(span?.attributes['swarm.id']).toBe(SWARM);
  });
});
