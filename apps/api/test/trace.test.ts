import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { SpanKind } from '@opentelemetry/api';
import { createApiCore } from '@swag/api-core';
import { createOrchestratorCore, type SandboxProvider } from '@swag/orchestrator-core';
import { createMemorySwarmStore } from '@swag/adapter-memory';
import { createOrchestratorHttpClient } from '@swag/adapter-orchestrator-http';
import {
  createMemoryExporters,
  startTelemetry,
  tracedHttpServer,
  type Telemetry,
} from '@swag/adapter-telemetry';
import { LogRecord, type PlatformEventInput } from '@swag/contracts';
import { buildApp } from '../src/app.ts';
import { buildApp as buildOrchestratorApp } from '../../orchestrator/src/app.ts';
import { actorOf, body, bearer, makeStartedAuth, T, WHO } from './support.ts';

const ADMIN = actorOf(WHO.adminA);

// AC-016-9: настоящие api и orchestrator на случайных портах, фейковый провайдер песочниц, спаны в памяти.
const TRACE = '4bf92f3577b34da6a3ce929d0e0e4736';
const REMOTE_SPAN = '00f067aa0ba902b7';
const ORCHESTRATOR_TOKEN = 'fake-orchestrator-token-for-tests-000000';

const apps: FastifyInstance[] = [];
let telemetry: Telemetry | null = null;
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  await telemetry?.shutdown();
  telemetry = null;
});

const portOf = (app: FastifyInstance): number => {
  const address = app.server.address();
  return typeof address === 'object' && address ? address.port : 0;
};

async function stack() {
  const memory = createMemoryExporters();
  const lines: string[] = [];
  telemetry = startTelemetry({
    service: 'api',
    version: 'test',
    otlpEndpoint: null,
    logLevel: 'debug', // все записи ядер и Fastify — для проверки утечки текста
    flushTimeoutMs: 500,
    stdout: (line) => lines.push(line),
    exporters: { spans: memory.spans },
  });
  const current = telemetry;
  let counter = 0;
  const ids = { uuid: () => `00000000-0000-4000-8000-${String(++counter).padStart(12, '0')}` };
  const clock = { now: () => '2026-10-22T10:00:00.000Z' };

  const published: PlatformEventInput[] = [];
  const sandboxes: SandboxProvider = {
    create: async () => ({ sandboxId: `sb-${++counter}` }),
    remove: async () => undefined,
    list: async () => [],
  };
  const orchestrator = createOrchestratorCore({
    version: 'test',
    llmSwarms: { register: async () => undefined, close: async () => null },
    sandboxes,
    bus: {
      publishEvent: async (event) => void published.push(event),
      publishMessage: async () => undefined,
    },
    clock,
    timers: { setTimeout: () => 0, clearTimeout: () => undefined },
    ids,
    log: current.logger,
    trace: current.trace,
    agent: {
      template: 'swag-agent:test',
      maxSteps: 20,
      maxTokens: 2048,
      llmGatewayToken: 'fake-gateway-token-for-tests-000000',
      flushTimeoutMs: 2000,
    },
    timeouts: { agentStartMs: 30000, swarmMs: 300000 },
  });
  const orchestratorApp = buildOrchestratorApp(
    orchestrator,
    {
      loggerInstance: current.logger.pino,
      serverFactory: tracedHttpServer(current),
    },
    { token: ORCHESTRATOR_TOKEN },
  );
  apps.push(orchestratorApp);
  await orchestratorApp.listen({ host: '127.0.0.1', port: 0 });

  const api = createApiCore({
    version: 'test',
    store: createMemorySwarmStore(),
    orchestrator: createOrchestratorHttpClient({
      baseUrl: `http://127.0.0.1:${portOf(orchestratorApp)}`,
      token: ORCHESTRATOR_TOKEN,
      timeoutMs: 5000,
    }),
    clock,
    ids,
    log: current.logger,
    trace: current.trace,
    limits: { maxActiveSwarms: 5, maxBudgetMicroUsd: 5000000, maxTokens: 65536 },
  });
  const apiApp = await buildApp(
    api,
    {
      loggerInstance: current.logger.pino,
      serverFactory: tracedHttpServer(current),
    },
    (await makeStartedAuth({ core: api })).app,
  );
  apps.push(apiApp);
  await apiApp.listen({ host: '127.0.0.1', port: 0 });

  const post = (traceparent: string, payload: unknown = body(2)) =>
    fetch(`http://127.0.0.1:${portOf(apiApp)}/swarms`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', traceparent, ...bearer(T.adminA) },
      body: JSON.stringify(payload),
    });
  return { memory, api, published, post, lines };
}

describe('трассировка HTTP api → orchestrator', () => {
  it('AC-016-9: серверный спан api, клиентский спан и серверный спан orchestrator в трейсе T; события несут T; невалидный traceparent — 201 и новый трейс', async () => {
    const { memory, api, published, post } = await stack();

    const response = await post(`00-${TRACE}-${REMOTE_SPAN}-01`);
    expect(response.status).toBe(201);
    const swarm = (await response.json()) as { id: string };

    await vi.waitFor(() =>
      expect(
        memory.finishedSpans.filter(
          (s) => s.spanContext().traceId === TRACE && s.kind === SpanKind.SERVER,
        ),
      ).toHaveLength(2),
    );
    const inTrace = memory.finishedSpans.filter((s) => s.spanContext().traceId === TRACE);
    const apiServer = inTrace.find(
      (s) => s.kind === SpanKind.SERVER && s.parentSpanContext?.spanId === REMOTE_SPAN,
    );
    const client = inTrace.find((s) => s.kind === SpanKind.CLIENT);
    const orchestratorServer = inTrace.find((s) => s.kind === SpanKind.SERVER && s !== apiServer);
    expect(apiServer?.attributes['url.path']).toBe('/swarms');
    expect(client?.parentSpanContext?.spanId).toBe(apiServer?.spanContext().spanId);
    expect(orchestratorServer?.parentSpanContext?.spanId).toBe(client?.spanContext().spanId);
    expect(orchestratorServer?.attributes['http.response.status_code']).toBe(202);

    const events = await api.getEvents(ADMIN, swarm.id, 0);
    expect(events.ok && events.value.find((e) => e.type === 'swarm.created')?.traceId).toBe(TRACE);
    const launched = published.filter((e) => e.type === 'agent.launched');
    expect(launched).toHaveLength(2);
    for (const event of launched) expect(event.traceId).toBe(TRACE);

    const invalid = await post('00-garbage-zzzz-01');
    expect(invalid.status).toBe(201);
    const other = (await invalid.json()) as { id: string };
    const otherEvents = await api.getEvents(ADMIN, other.id, 0);
    const created = otherEvents.ok
      ? otherEvents.value.find((e) => e.type === 'swarm.created')
      : undefined;
    expect(created?.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(created?.traceId).not.toBe(TRACE);
  });

  it('AC-016-13: через HTTP с Fastify на общем логгере — маркер из задачи и ролей не попадает ни в логи, ни в спаны; все строки — LogRecord с traceId', async () => {
    const { memory, post, lines } = await stack();
    const marker = 'SECRET-MARKER-016';
    const response = await post(`00-${TRACE}-${REMOTE_SPAN}-01`, {
      task: `Задача ${marker}`,
      budgetMicroUsd: 1000000,
      agents: [{ name: 'A', role: `роль ${marker}` }],
    });
    expect(response.status).toBe(201);
    await vi.waitFor(() =>
      expect(memory.finishedSpans.filter((s) => s.kind === SpanKind.SERVER)).toHaveLength(2),
    );

    expect(lines.some((line) => line.includes('"msg":"swarm created"'))).toBe(true);
    expect(lines.some((line) => line.includes('incoming request'))).toBe(true);
    for (const line of lines) {
      expect(line).not.toContain(marker);
      const record = LogRecord.parse(JSON.parse(line));
      if (record.msg === 'swarm created') expect(record.traceId).toBe(TRACE);
    }
    for (const span of memory.finishedSpans) {
      expect(JSON.stringify(span.attributes)).not.toContain(marker);
      expect(JSON.stringify(span.events)).not.toContain(marker);
    }
  });
});
