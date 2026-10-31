import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createLiteLlmUpstream } from '@swag/adapter-litellm';
import { ledgerReport, runMigrations } from '@swag/adapter-postgres';
import { createMemoryExporters, startTelemetry } from '@swag/adapter-telemetry';
import type { PlatformEventInput } from '@swag/contracts';
import { startFakeProvider } from '../../../infra/llm/fake-provider/server.ts';
import { formatMoneyReport } from '../../../scripts/money-report.ts';
import { buildApp, telemetryAppOptions } from '../src/app.ts';
import { readCatalog } from '../src/catalog.ts';
import { startLlmGatewayCore } from '../src/start.ts';
import { catalogPath, GATEWAY_TOKEN, gatewayOptions, listenUrl, MASTER_KEY } from './support.ts';

// Спека 004, AC-004-33 (нужен Postgres: POSTGRES_TEST_URL, без него тест пропускается).
// Маркер в тексте вызова нужен, чтобы убедиться, что вызов дошёл до провайдера; сам маркер в логи не попадает (002, AC-002-23).
const url = process.env['POSTGRES_TEST_URL'];
const MARKER = 'MARKER-7f3a';
const LIMIT = 1_000_000_000;
const JSON_HEADERS = { 'content-type': 'application/json' };
const AUTH = { authorization: `Bearer ${GATEWAY_TOKEN}` };

describe.skipIf(!url)('безопасность денег на Postgres (спека 004, AC-004-33)', () => {
  const schema = `test_${randomUUID().replaceAll('-', '')}`;
  let admin: pg.Client;

  beforeAll(async () => {
    admin = new pg.Client({ connectionString: url ?? '' });
    await admin.connect();
    await admin.query(`create schema ${schema}`);
    await runMigrations(url ?? '', { schema });
  });

  afterAll(async () => {
    await admin.query(`drop schema ${schema} cascade`);
    await admin.end();
  });

  it('AC-004-33: вызов с маркером, регистрация и закрытие роя — токена шлюза нет в логах, спанах, событиях, отчёте и строках таблиц 4.5', async () => {
    const memory = createMemoryExporters();
    const lines: string[] = [];
    const telemetry = startTelemetry({
      service: 'llm-gateway',
      version: 'test',
      otlpEndpoint: null,
      logLevel: 'debug', // все записи — для проверки утечки
      flushTimeoutMs: 500,
      stdout: (line) => lines.push(line),
      exporters: { spans: memory.spans },
    });
    const fake = await startFakeProvider({ port: 0 });
    const events: PlatformEventInput[] = [];
    try {
      const { core, pool } = await startLlmGatewayCore(
        { databaseUrl: url ?? '', schema },
        {
          catalog: readCatalog(catalogPath),
          upstream: createLiteLlmUpstream({
            baseUrl: fake.url,
            masterKey: MASTER_KEY,
            idleTimeoutMs: 5_000,
            secrets: [MASTER_KEY],
          }),
          events: { publishEvent: async (event) => void events.push(event) },
          clock: { now: () => new Date(), monotonicMs: () => performance.now() },
          ids: { uuid: () => randomUUID() },
          trace: telemetry.trace,
          log: telemetry.logger,
          version: 'test',
          sleep: (ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)), // спека 013, 4.7
          closeWaitMs: 5000,
        },
      );
      let app: FastifyInstance | undefined;
      try {
        app = await buildApp(core, gatewayOptions, telemetryAppOptions(telemetry));
        const base = await listenUrl(app);
        const swarmId = randomUUID();

        const registered = await fetch(`${base}/internal/swarms`, {
          method: 'POST',
          headers: { ...AUTH, ...JSON_HEADERS },
          body: JSON.stringify({
            swarmId,
            budgetMicroUsd: LIMIT,
            expiresAt: null,
            agents: [{ agentId: 'agent-1', model: 'chat-small', budgetMicroUsd: null }],
          }),
        });
        expect(registered.status).toBe(204);

        const call = await fetch(`${base}/v1/chat/completions`, {
          method: 'POST',
          headers: {
            ...AUTH,
            ...JSON_HEADERS,
            'x-swag-swarm-id': swarmId,
            'x-swag-agent-id': 'agent-1',
          },
          body: JSON.stringify({
            model: 'chat-small',
            max_tokens: 256,
            messages: [{ role: 'user', content: `${MARKER} привет` }],
          }),
        });
        expect(call.status).toBe(200);
        await call.text();
        expect(JSON.stringify(fake.requests)).toContain(MARKER);

        const closed = await fetch(`${base}/internal/swarms/${swarmId}/close`, {
          method: 'POST',
          headers: AUTH,
        });
        expect(closed.status).toBe(200);

        const report = formatMoneyReport(await ledgerReport(pool, { swarmId }));
        const ledger = await pool.query<{ n: number }>(
          'select count(*)::int as n from ledger_entries where swarm_id = $1',
          [swarmId],
        );
        expect(ledger.rows[0]?.n).toBe(1);

        const tables = [
          'swarm_budgets',
          'swarm_agents',
          'budget_holds',
          'ledger_entries',
          'model_prices',
        ];
        const rows = await Promise.all(tables.map((table) => pool.query(`select * from ${table}`)));

        // Проверка не пустая: логи, спаны и события собраны, в таблицах есть строки роя.
        expect(lines.length).toBeGreaterThan(0);
        expect(events.length).toBeGreaterThan(0);

        const dump = [
          lines.join('\n'),
          JSON.stringify(
            memory.finishedSpans.map((span) => ({ a: span.attributes, e: span.events })),
          ),
          JSON.stringify(events),
          report,
          JSON.stringify(rows.map((result) => result.rows)),
        ].join('\n');
        expect(dump).not.toContain(GATEWAY_TOKEN);
      } finally {
        await app?.close();
        await pool.end();
      }
    } finally {
      await fake.close();
      await telemetry.shutdown();
    }
  }, 30_000);
});
