import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { startTelemetry, type Telemetry } from '@swag/adapter-telemetry';
import type { PlatformEventInput } from '@swag/contracts';
import { startFakeProvider, type FakeProvider } from '../../../infra/llm/fake-provider/server.ts';
import { buildApp, telemetryAppOptions } from '../src/app.ts';
import { caller, createMemoryBus, gatewayOptions, listenUrl, makeCore } from './support.ts';

// p95 — метод ближайшего ранга: из 200 значений это 190-е по возрастанию.

const ROUNDS = 200;
const WARMUP = 20;
const body = JSON.stringify({
  model: 'chat-small',
  max_tokens: 256,
  messages: [{ role: 'user', content: 'ping' }],
});
const plainHeaders = { 'content-type': 'application/json' };
const gatewayHeaders = { ...plainHeaders, ...caller };

function percentile(sorted: number[], p: number): number {
  return sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)] ?? NaN;
}

const round = (ms: number) => Math.round(ms * 100) / 100;

async function timed(url: string, headers: Record<string, string>): Promise<number> {
  const started = performance.now();
  const response = await fetch(url, { method: 'POST', headers, body });
  await response.arrayBuffer();
  const elapsed = performance.now() - started;
  if (response.status !== 200) throw new Error(`замер: статус ${response.status} на ${url}`);
  return elapsed;
}

describe.skipIf(!process.env.LLM_GATEWAY_BENCH)('llm-gateway [bench]', () => {
  let fake: FakeProvider;
  let telemetry: Telemetry;
  let app: FastifyInstance;
  let gatewayUrl: string;

  beforeAll(async () => {
    fake = await startFakeProvider({ port: 0 });
    // Прод-путь оболочки (main.ts): телеметрия без OTLP, логи в null-поток, серверный спан через tracedHttpServer.
    telemetry = startTelemetry({
      service: 'llm-gateway',
      version: 'bench',
      otlpEndpoint: null,
      logLevel: 'info',
      flushTimeoutMs: 500,
      stdout: () => undefined,
    });
    const bus = createMemoryBus();
    const core = makeCore(
      fake.url,
      telemetry.logger,
      {
        publishEvent: async (event: PlatformEventInput) =>
          bus.publish(`swarm.${event.swarmId}.events`, event),
      },
      { trace: telemetry.trace },
    );
    app = await buildApp(core, gatewayOptions, telemetryAppOptions(telemetry));
    gatewayUrl = await listenUrl(app);
  });

  afterAll(async () => {
    await app.close();
    await telemetry.shutdown();
    await fake.close();
  });

  it('NFR-002-1: задержка шлюза поверх апстрима, вызовы без потока, p95 — разница с прямым вызовом', async () => {
    const direct = `${fake.url}/v1/chat/completions`;
    const viaGateway = `${gatewayUrl}/v1/chat/completions`;

    const directMs: number[] = [];
    const gatewayMs: number[] = [];
    for (let i = 0; i < WARMUP + ROUNDS; i++) {
      let directOne: number;
      let gatewayOne: number;
      if (i % 2 === 0) {
        directOne = await timed(direct, plainHeaders);
        gatewayOne = await timed(viaGateway, gatewayHeaders);
      } else {
        gatewayOne = await timed(viaGateway, gatewayHeaders);
        directOne = await timed(direct, plainHeaders);
      }
      if (i < WARMUP) continue;
      directMs.push(directOne);
      gatewayMs.push(gatewayOne);
    }

    const sortedDirect = [...directMs].sort((a, b) => a - b);
    const sortedGateway = [...gatewayMs].sort((a, b) => a - b);
    const p95Direct = percentile(sortedDirect, 0.95);
    const p95Gateway = percentile(sortedGateway, 0.95);
    const result = {
      rounds: ROUNDS,
      p50DirectMs: round(percentile(sortedDirect, 0.5)),
      p95DirectMs: round(p95Direct),
      p50GatewayMs: round(percentile(sortedGateway, 0.5)),
      p95GatewayMs: round(p95Gateway),
      p95DiffMs: round(p95Gateway - p95Direct),
    };
    process.stdout.write(`NFR-002-1 ${JSON.stringify(result)}\n`);
    expect(directMs).toHaveLength(ROUNDS);
    expect(gatewayMs).toHaveLength(ROUNDS);
  }, 120_000);
});
