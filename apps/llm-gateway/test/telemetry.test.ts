import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { SpanKind } from '@opentelemetry/api';
import { createMemoryExporters, startTelemetry, type Telemetry } from '@swag/adapter-telemetry';
import { LogRecord, type PlatformEventInput } from '@swag/contracts';
import { startFakeProvider, type FakeProvider } from '../../../infra/llm/fake-provider/server.ts';
import { buildApp, telemetryAppOptions } from '../src/app.ts';
import { caller, gatewayOptions, listenUrl, makeCore, MASTER_KEY, SWARM_ID } from './support.ts';

// Спека 002, 4.10 и REQ-002-14, REQ-002-11 (оболочка), AC-002-17, AC-002-23. Оболочка собрана как в apps/api:
// startTelemetry с логом в память, Fastify на общем логгере и tracedHttpServer, спаны — в памяти.

const FAKE_KEY = 'fake-provider-key-not-secret';
const MARKER = 'MARKER-7f3a';
const TRACE = '4bf92f3577b34da6a3ce929d0e0e4736';
const REMOTE_SPAN = '00f067aa0ba902b7';

const headers = { ...caller, 'content-type': 'application/json' };
const chat = (content: string, stream = false) => ({
  model: 'chat-small',
  messages: [{ role: 'user', content }],
  stream,
});

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close();
});

async function openTelemetryGateway(masterKey: string = MASTER_KEY) {
  const memory = createMemoryExporters();
  const lines: string[] = [];
  const telemetry: Telemetry = startTelemetry({
    service: 'llm-gateway',
    version: 'test',
    otlpEndpoint: null,
    logLevel: 'debug', // все записи — для проверки утечки текста
    flushTimeoutMs: 500,
    stdout: (line) => lines.push(line),
    exporters: { spans: memory.spans },
  });
  closers.push(() => telemetry.shutdown());
  const fake: FakeProvider = await startFakeProvider({ port: 0 });
  closers.push(() => fake.close());
  const events: PlatformEventInput[] = [];
  const core = makeCore(
    fake.url,
    telemetry.logger,
    { publishEvent: async (event) => void events.push(event) },
    { trace: telemetry.trace, secrets: [MASTER_KEY, FAKE_KEY], masterKey },
  );
  const app: FastifyInstance = await buildApp(core, gatewayOptions, telemetryAppOptions(telemetry));
  closers.push(() => app.close());
  const url = `${await listenUrl(app)}/v1/chat/completions`;
  return { url, fake, events, lines, memory };
}

const records = (lines: string[]) => lines.map((line) => LogRecord.parse(JSON.parse(line)));
const callRecords = (lines: string[]) =>
  records(lines).filter((record) => record.msg === 'llm call');
const serverSpans = (memory: ReturnType<typeof createMemoryExporters>) =>
  memory.finishedSpans.filter((span) => span.kind === SpanKind.SERVER);
// Спаны и события без лишних полей: то, что уходит наружу из оболочки.
const spanText = (memory: ReturnType<typeof createMemoryExporters>) =>
  JSON.stringify(memory.finishedSpans.map((span) => ({ a: span.attributes, e: span.events })));

describe('телеметрия оболочки llm-gateway (4.10)', () => {
  it('AC-002-23: без потока и потоком маркер не попадает в логи и спаны; на каждый вызов одна запись llm call', async () => {
    const gateway = await openTelemetryGateway();

    const json = await fetch(gateway.url, {
      method: 'POST',
      headers,
      body: JSON.stringify(chat(`${MARKER} привет`)),
    });
    expect(json.status).toBe(200);
    await json.text();
    await vi.waitFor(() => expect(callRecords(gateway.lines)).toHaveLength(1), { timeout: 3000 });

    const stream = await fetch(gateway.url, {
      method: 'POST',
      headers,
      body: JSON.stringify(chat(`${MARKER} поток`, true)),
    });
    expect(stream.status).toBe(200);
    await stream.text();

    // Ждём события обоих вызовов и только потом проверяем, что записей ровно две.
    await vi.waitFor(() => expect(gateway.events).toHaveLength(2), { timeout: 3000 });
    await vi.waitFor(() => expect(callRecords(gateway.lines)).toHaveLength(2), { timeout: 3000 });
    await vi.waitFor(() => expect(serverSpans(gateway.memory)).toHaveLength(2), { timeout: 3000 });
    expect(callRecords(gateway.lines)).toHaveLength(2);
    expect(serverSpans(gateway.memory)).toHaveLength(2);

    for (const record of callRecords(gateway.lines)) {
      expect(record).toMatchObject({
        level: 'info',
        service: 'llm-gateway',
        swarmId: SWARM_ID,
        agentId: 'agent-1',
        model: 'chat-small',
        status: 'ok',
        promptTokens: 1000,
        completionTokens: 500,
        costMicroUsd: 9960,
      });
      expect(typeof record.latencyMs).toBe('number');
    }
    expect(callRecords(gateway.lines).map((record) => record.stream)).toEqual([false, true]);

    // Маркер реально дошёл до фейка в обоих вызовах, но наружу из оболочки не выходит.
    expect(gateway.fake.requests).toHaveLength(2);
    for (const request of gateway.fake.requests) {
      expect(JSON.stringify(request.body)).toContain(MARKER);
    }
    for (const line of gateway.lines) expect(line).not.toContain(MARKER);
    expect(spanText(gateway.memory)).not.toContain(MARKER);
    expect(JSON.stringify(gateway.events)).not.toContain(MARKER);
  });

  it.each([
    ['мастер-ключ', MASTER_KEY],
    ['ключ фейка', FAKE_KEY],
  ])(
    'AC-002-17: __fail_400__ через оболочку (masterKey — %s): ответ, логи, спаны и событие без ключей, в message ***',
    async (_label, masterKey) => {
      const gateway = await openTelemetryGateway(masterKey);

      const response = await fetch(gateway.url, {
        method: 'POST',
        headers,
        body: JSON.stringify(chat('__fail_400__')),
      });
      expect(response.status).toBe(400);
      const body = (await response.json()) as { error: { message: string } };
      expect(body.error.message).toBe('bad request, auth was: Bearer ***');
      // Ключ прохода реально ушёл фейку: секрет есть в апстриме, но наружу не выходит.
      expect(gateway.fake.requests[0]?.headers['authorization']).toBe(`Bearer ${masterKey}`);

      await vi.waitFor(() => expect(callRecords(gateway.lines)).toHaveLength(1), { timeout: 3000 });
      await vi.waitFor(() => expect(serverSpans(gateway.memory)).toHaveLength(1), {
        timeout: 3000,
      });
      await vi.waitFor(() => expect(gateway.events).toHaveLength(1), { timeout: 3000 });
      expect(callRecords(gateway.lines)[0]?.level).toBe('warn');

      const outside = [...gateway.lines, spanText(gateway.memory), JSON.stringify(gateway.events)];
      for (const text of outside) {
        expect(text).not.toContain(MASTER_KEY);
        expect(text).not.toContain(FAKE_KEY);
      }
    },
  );

  it.each([false, true])(
    'REQ-002-14: трейс продолжается из traceparent (поток: %s) — запись llm call, событие и серверный спан в трейсе запроса',
    async (stream) => {
      const gateway = await openTelemetryGateway();

      const response = await fetch(gateway.url, {
        method: 'POST',
        headers: { ...headers, traceparent: `00-${TRACE}-${REMOTE_SPAN}-01` },
        body: JSON.stringify(chat('привет', stream)),
      });
      expect(response.status).toBe(200);
      await response.text();
      await vi.waitFor(() => expect(callRecords(gateway.lines)).toHaveLength(1), { timeout: 3000 });
      await vi.waitFor(() => expect(serverSpans(gateway.memory)).toHaveLength(1), {
        timeout: 3000,
      });
      await vi.waitFor(() => expect(gateway.events).toHaveLength(1), { timeout: 3000 });

      const [server] = serverSpans(gateway.memory);
      expect(server?.spanContext().traceId).toBe(TRACE);
      expect(server?.parentSpanContext?.spanId).toBe(REMOTE_SPAN);
      expect(server?.attributes['url.path']).toBe('/v1/chat/completions');
      expect(callRecords(gateway.lines)[0]).toMatchObject({
        traceId: TRACE,
        spanId: server?.spanContext().spanId,
        stream,
      });
      expect(gateway.events[0]?.traceId).toBe(TRACE);
    },
  );
});
