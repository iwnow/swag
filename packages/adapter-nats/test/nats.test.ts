import { describe, expect, it } from 'vitest';
import { connect } from '@nats-io/transport-node';
import { ALL_EVENTS, ALL_INBOXES, eventsSubject, inboxSubject } from '@swag/contracts';
import { SpanKind, SpanStatusCode, type HrTime } from '@opentelemetry/api';
import { createMemoryExporters, startTelemetry } from '@swag/adapter-telemetry';
import { connectNatsBus, subjectAttributes } from '../src/index.ts';

// Нужен запущенный NATS: NATS_TEST_URL, например nats://127.0.0.1:4222 (compose или сервис в CI).
const url = process.env['NATS_TEST_URL'];
const SWARM = '0b6f6d2e-6a4c-4c3e-9f5e-111111111111';
const TRACE = '4bf92f3577b34da6a3ce929d0e0e4736';

describe.skipIf(!url)('adapter-nats', () => {
  it('AC-001-21: BusMessage и событие приходят неизменёнными; невалидный JSON не ломает подписку', async () => {
    const bus = await connectNatsBus({ url: url ?? '' });
    const raw = await connect({ servers: url ?? '' });
    const inbox: unknown[] = [];
    const events: unknown[] = [];
    bus.subscribeJson(ALL_INBOXES, (value) => void inbox.push(value));
    bus.subscribeJson(ALL_EVENTS, (value) => void events.push(value));

    const message = {
      id: '0b6f6d2e-6a4c-4c3e-9f5e-222222222222',
      swarmId: SWARM,
      from: 'user',
      to: 'agent-1',
      text: 'Привет',
      ts: '2026-10-22T10:00:00.000Z',
    };
    const event = {
      id: '0b6f6d2e-6a4c-4c3e-9f5e-333333333333',
      swarmId: SWARM,
      ts: '2026-10-22T10:00:00.000Z',
      source: 'orchestrator',
      agentId: null,
      traceId: null,
      type: 'swarm.started',
      data: {},
    };

    await bus.publishJson(inboxSubject(SWARM, 'agent-1'), message);
    raw.publish(inboxSubject(SWARM, 'agent-1'), new TextEncoder().encode('{не json'));
    await bus.publishJson(eventsSubject(SWARM), event);
    await raw.flush();

    await waitFor(() => expect(inbox).toHaveLength(1));
    await waitFor(() => expect(events).toHaveLength(1));
    expect(inbox[0]).toEqual(message);
    expect(events[0]).toEqual(event);

    await raw.close();
    await bus.close();
  });

  it('AC-016-8: traceparent в заголовке — обработчик в трейсе T, спаны producer и consumer; без заголовка — новый трейс', async () => {
    const memory = createMemoryExporters();
    const telemetry = startTelemetry({
      service: 'api',
      version: 'test',
      otlpEndpoint: null,
      logLevel: 'info',
      flushTimeoutMs: 500,
      stdout: () => undefined,
      exporters: { spans: memory.spans },
    });
    const bus = await connectNatsBus({ url: url ?? '' });
    const raw = await connect({ servers: url ?? '' });
    try {
      const seen: { value: unknown; traceId: string | null }[] = [];
      bus.subscribeJson(ALL_EVENTS, (value) => {
        seen.push({ value, traceId: telemetry.trace.currentTraceId() });
      });
      await bus.publishJson(eventsSubject(SWARM), { warmup: true }); // подписка зарегистрирована
      await waitFor(() => expect(seen).toHaveLength(1));

      const event = { kind: 'traced', n: 1 };
      await telemetry.inSpan('test', { parent: `00-${TRACE}-00f067aa0ba902b7-01` }, () =>
        bus.publishJson(eventsSubject(SWARM), event),
      );
      raw.publish(eventsSubject(SWARM), new TextEncoder().encode(JSON.stringify({ kind: 'raw' })));
      await raw.flush();
      await waitFor(() => expect(seen).toHaveLength(3));

      const traced = seen.find((s) => (s.value as { kind?: string }).kind === 'traced');
      expect(traced?.value).toEqual(event);
      expect(traced?.traceId).toBe(TRACE);
      const plain = seen.find((s) => (s.value as { kind?: string }).kind === 'raw');
      expect(plain?.traceId).toMatch(/^[0-9a-f]{32}$/);
      expect(plain?.traceId).not.toBe(TRACE);

      const inTrace = memory.finishedSpans.filter((s) => s.spanContext().traceId === TRACE);
      const producer = inTrace.find((s) => s.kind === SpanKind.PRODUCER);
      const consumer = inTrace.find((s) => s.kind === SpanKind.CONSUMER);
      for (const span of [producer, consumer]) {
        expect(span?.attributes['messaging.system']).toBe('nats');
        expect(span?.attributes['messaging.destination.name']).toBe(eventsSubject(SWARM));
        expect(span?.attributes['swarm.id']).toBe(SWARM);
      }
      expect(consumer?.parentSpanContext?.spanId).toBe(producer?.spanContext().spanId);
    } finally {
      await raw.close();
      await bus.close();
      await telemetry.shutdown();
    }
  });

  it('AC-022-22: обработчик-Promise — спан consumer ждёт его; сообщения по одному; отказ — статус ERROR', async () => {
    const memory = createMemoryExporters();
    const telemetry = startTelemetry({
      service: 'api',
      version: 'test',
      otlpEndpoint: null,
      logLevel: 'info',
      flushTimeoutMs: 500,
      stdout: () => undefined,
      exporters: { spans: memory.spans },
    });
    const bus = await connectNatsBus({ url: url ?? '', warn: () => undefined });
    try {
      const log: string[] = [];
      bus.subscribeJson(eventsSubject(SWARM), async (value) => {
        const { n } = value as { n: number };
        log.push(`start ${n}`);
        if (n === 2) throw new Error('boom');
        await delay(200);
        log.push(`end ${n}`);
      });
      await bus.publishJson(eventsSubject(SWARM), { n: 1 });
      await bus.publishJson(eventsSubject(SWARM), { n: 2 });
      await waitFor(() => expect(log).toHaveLength(3));

      const consumers = memory.finishedSpans.filter(
        (s) =>
          s.kind === SpanKind.CONSUMER &&
          s.attributes['messaging.destination.name'] === eventsSubject(SWARM),
      );
      await waitFor(() => expect(consumers).toHaveLength(2));
      expect(log).toEqual(['start 1', 'end 1', 'start 2']);
      const [first, second] = consumers;
      expect(
        spanMs(first?.endTime ?? [0, 0]) - spanMs(first?.startTime ?? [0, 0]),
      ).toBeGreaterThanOrEqual(200);
      expect(second?.status.code).toBe(SpanStatusCode.ERROR);
    } finally {
      await bus.close();
      await telemetry.shutdown();
    }
  });
});

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function spanMs(time: HrTime): number {
  return time[0] * 1e3 + time[1] / 1e6;
}

describe('subjectAttributes', () => {
  it('разбирает swarmId и agentId из subjects 4.2', () => {
    expect(subjectAttributes(inboxSubject(SWARM, 'agent-2'))).toEqual({
      template: 'swarm.{swarmId}.agent.{agentId}.inbox',
      attributes: {
        'messaging.system': 'nats',
        'messaging.destination.name': inboxSubject(SWARM, 'agent-2'),
        'swarm.id': SWARM,
        'agent.id': 'agent-2',
      },
    });
    expect(subjectAttributes('other.subject').attributes).not.toHaveProperty('swarm.id');
  });
});

async function waitFor(assertion: () => void, timeoutMs = 5000): Promise<void> {
  const started = Date.now();
  for (;;) {
    try {
      assertion();
      return;
    } catch (error) {
      if (Date.now() - started > timeoutMs) throw error;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
}
