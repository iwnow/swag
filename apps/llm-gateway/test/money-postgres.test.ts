import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { projectSwarm } from '@swag/api-integration';
import { createPostgresBudgetStore, runMigrations } from '@swag/adapter-postgres';
import type { PlatformEvent, PlatformEventInput } from '@swag/contracts';
import { startLlmGatewayCore } from '../src/start.ts';
import { readCatalog } from '../src/catalog.ts';
import { startFakeProvider, type FakeProvider } from '../../../infra/llm/fake-provider/server.ts';
import {
  fakeClock,
  fakeIds,
  fakeTrace,
  fakeUpstream,
} from '../../../packages/llm-gateway-core/test/fakes.ts';
import { catalogPath, makeCore, recordingLog } from './support.ts';

// Спека 004, AC-004-18 (старт) и AC-004-19 (сверка ledger). Нужен Postgres: POSTGRES_TEST_URL, без него тесты пропускаются.
const url = process.env['POSTGRES_TEST_URL'];
const LIMIT = 1_000_000_000;
const AGENTS = ['agent-1', 'agent-2', 'agent-3'];

const registration = (swarmId: string) => ({
  swarmId,
  budgetMicroUsd: LIMIT,
  expiresAt: null,
  agents: AGENTS.map((agentId) => ({ agentId, model: 'chat-small', budgetMicroUsd: null })),
});

describe.skipIf(!url)('llm-gateway с Postgres (спека 004, 4.4, 4.5)', () => {
  const schema = `test_${randomUUID().replaceAll('-', '')}`;
  const pools: pg.Pool[] = [];
  const newPool = (): pg.Pool => {
    const pool = new pg.Pool({
      connectionString: url,
      max: 10,
      options: `-c search_path=${schema}`,
    });
    pools.push(pool);
    return pool;
  };
  let admin: pg.Client;

  beforeAll(async () => {
    admin = new pg.Client({ connectionString: url ?? '' });
    await admin.connect();
    await admin.query(`create schema ${schema}`);
    await runMigrations(url ?? '', { schema });
  });

  afterAll(async () => {
    await Promise.allSettled(pools.map((pool) => pool.end()));
    await admin.query(`drop schema ${schema} cascade`);
    await admin.end();
  });

  it('AC-004-18: висящие резервы от прошлого процесса освобождены до возврата из старта, записей ledger нет', async () => {
    const pool = newPool();
    const store = createPostgresBudgetStore(pool);
    const swarmId = randomUUID();
    const now = new Date('2026-10-30T10:00:00.000Z');
    await store.register(registration(swarmId), now);
    const first = randomUUID();
    const second = randomUUID();
    expect(await store.reserve(first, { swarmId, agentId: 'agent-1' }, 700, now)).toEqual({
      ok: true,
    });
    expect(await store.reserve(second, { swarmId, agentId: 'agent-2' }, 300, now)).toEqual({
      ok: true,
    });

    const { log, entries } = recordingLog();
    const { pool: startPool } = await startLlmGatewayCore(
      { databaseUrl: url ?? '', schema },
      {
        catalog: readCatalog(catalogPath),
        upstream: fakeUpstream(),
        events: { publishEvent: async () => undefined },
        clock: fakeClock(),
        ids: fakeIds(),
        trace: fakeTrace(),
        log,
        version: 'test',
      },
    );
    try {
      const holds = await pool.query<{ n: number }>(
        'select count(*)::int as n from budget_holds where swarm_id = $1',
        [swarmId],
      );
      const swarm = await pool.query<{ held: number }>(
        'select held_micro_usd::int as held from swarm_budgets where swarm_id = $1',
        [swarmId],
      );
      const agents = await pool.query<{ held: number }>(
        'select coalesce(sum(held_micro_usd), 0)::int as held from swarm_agents where swarm_id = $1',
        [swarmId],
      );
      const ledger = await pool.query<{ n: number }>(
        'select count(*)::int as n from ledger_entries where swarm_id = $1',
        [swarmId],
      );
      expect(holds.rows[0]?.n).toBe(0);
      expect(swarm.rows[0]?.held).toBe(0);
      expect(agents.rows[0]?.held).toBe(0);
      expect(ledger.rows[0]?.n).toBe(0);

      const released = entries.filter((entry) => entry.msg === 'hold_released');
      expect(released).toHaveLength(2);
      expect(released.every((entry) => entry.level === 'warn')).toBe(true);
      expect(released.map((entry) => entry.ctx?.['callId']).sort()).toEqual([first, second].sort());
    } finally {
      await startPool.end();
    }
  });

  it('AC-004-19: 12 вызовов роя из трёх агентов и закрытие — ledger, charge событий, ответ закрытия и projectSwarm сходятся', async () => {
    const fake: FakeProvider = await startFakeProvider({ port: 0 });
    const pool = newPool();
    const swarmId = randomUUID();
    const events: PlatformEventInput[] = [];
    try {
      const budgets = createPostgresBudgetStore(pool);
      await budgets.register(registration(swarmId), new Date());
      const core = makeCore(
        fake.url,
        recordingLog().log,
        { publishEvent: async (event) => void events.push(event) },
        { budgets, idleTimeoutMs: 1_000 },
      );

      // Для каждого агента четыре вызова: без потока, потоком, без ответа до обрыва клиентом, с ошибкой апстрима.
      for (const agent of AGENTS) {
        for (const scenario of ['plain', 'stream', 'hang', 'fail'] as const) {
          const controller = new AbortController();
          const content =
            scenario === 'fail' ? '__fail_500__' : scenario === 'hang' ? '__hang__' : 'ping';
          const body = {
            model: 'chat-small',
            max_tokens: 256,
            messages: [{ role: 'user', content }],
            ...(scenario === 'stream' ? { stream: true } : {}),
          };
          const timer = scenario === 'hang' ? setTimeout(() => controller.abort(), 50) : undefined;
          const result = await core.complete({ swarmId, agentId: agent }, body, controller.signal);
          if (timer) clearTimeout(timer);
          if (result.kind === 'stream') {
            try {
              for await (const _payload of result.chunks) {
                controller.abort();
              }
            } catch {
              // обрыв потока после отмены ожидаем: событие и запись ledger пишет ядро
            }
          }
        }
      }

      const closed = await core.closeSwarm(swarmId);
      expect(closed.ok).toBe(true);
      const spent = closed.ok ? closed.value.spentMicroUsd : -1;

      const ledger = await pool.query<{ n: number; sum: string }>(
        'select count(*)::int as n, coalesce(sum(amount_micro_usd), 0)::text as sum from ledger_entries where swarm_id = $1',
        [swarmId],
      );
      const ledgerSum = Number(ledger.rows[0]?.sum ?? 0);
      const chargeSum = events.reduce((total, event) => {
        if (event.type !== 'llm.call' || event.swarmId !== swarmId) return total;
        return total + (event.data.charge?.microUsd ?? 0);
      }, 0);

      expect(ledger.rows[0]?.n).toBe(12);
      expect(ledgerSum).toBe(chargeSum);
      expect(ledgerSum).toBe(spent);

      // spentMicroUsd проекции по опубликованным событиям роя (4.7, D-95) сходится с тем же числом.
      const created = {
        id: randomUUID(),
        swarmId,
        ts: new Date().toISOString(),
        source: 'api',
        agentId: null,
        traceId: null,
        type: 'swarm.created',
        data: {
          task: 'T',
          budgetMicroUsd: LIMIT,
          agents: AGENTS.map((id) => ({
            id,
            name: id,
            role: 'r',
            model: 'chat-small',
            budgetMicroUsd: null,
          })),
        },
      } as PlatformEventInput;
      const roiEvents = [created, ...events.filter((e) => e.swarmId === swarmId)];
      const view = projectSwarm(roiEvents.map((e, i) => ({ ...e, seq: i + 1 }) as PlatformEvent));
      expect(view.spentMicroUsd).toBe(spent);
    } finally {
      await fake.close();
    }
  }, 30_000);
});
