import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ChargeBasis, LlmSwarmRegistration } from '@swag/contracts';
import type { LedgerEntry } from '@swag/llm-gateway-core';
import {
  createPostgresBudgetStore,
  createPostgresPriceStore,
  ledgerReport,
  runMigrations,
} from '../src/index.ts';

// Нужен запущенный Postgres: POSTGRES_TEST_URL. Схема создаётся на время файла (спека 004, 4.5).
const url = process.env['POSTGRES_TEST_URL'];
const NOW = new Date('2026-10-30T10:00:00.000Z');
const AGENTS_8 = Array.from({ length: 8 }, (_, index) => ({ agentId: `agent-${index + 1}` }));

const registration = (
  swarmId: string,
  budgetMicroUsd: number,
  agents: { agentId: string; budgetMicroUsd?: number | null }[] = [{ agentId: 'agent-1' }],
  expiresAt: string | null = null,
): LlmSwarmRegistration => ({
  swarmId,
  budgetMicroUsd,
  expiresAt,
  agents: agents.map((agent) => ({
    agentId: agent.agentId,
    model: 'chat-small',
    budgetMicroUsd: agent.budgetMicroUsd ?? null,
  })),
});

const entry = (
  callId: string,
  swarmId: string,
  agentId: string,
  amountMicroUsd: number,
  options: { providerCostMicroUsd?: number | null; ts?: string; basis?: ChargeBasis } = {},
): LedgerEntry => ({
  callId,
  ts: options.ts ?? '2026-10-30T10:00:01.000Z',
  swarmId,
  agentId,
  model: 'chat-small',
  kind: 'llm',
  amountMicroUsd,
  basis: options.basis ?? 'usage',
  providerCostMicroUsd: options.providerCostMicroUsd ?? null,
});

describe.skipIf(!url)('adapter-postgres деньги', () => {
  const schema = `test_${randomUUID().replaceAll('-', '')}`;
  const pools: pg.Pool[] = [];
  const schemas: string[] = [];
  const newPool = (): pg.Pool => {
    const pool = new pg.Pool({
      connectionString: url,
      max: 20,
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
    for (const name of [schema, ...schemas]) await admin.query(`drop schema ${name} cascade`);
    await admin.end();
  });

  const heldOf = async (pool: pg.Pool, swarmId: string): Promise<number> => {
    const result = await pool.query<{ held: string }>(
      'select held_micro_usd as held from swarm_budgets where swarm_id = $1',
      [swarmId],
    );
    return Number(result.rows[0]?.held);
  };
  const countRows = async (pool: pg.Pool, table: string, swarmId?: string): Promise<number> => {
    const result = await pool.query<{ count: string }>(
      swarmId === undefined
        ? `select count(*) as count from ${table}`
        : `select count(*) as count from ${table} where swarm_id = $1`,
      swarmId === undefined ? [] : [swarmId],
    );
    return Number(result.rows[0]?.count);
  };
  // releaseHolds снимает все резервы таблицы: тесты с ним работают в собственной схеме, резервы других тестов не мешают.
  const isolatedPool = async (): Promise<pg.Pool> => {
    const isolated = `test_${randomUUID().replaceAll('-', '')}`;
    await admin.query(`create schema ${isolated}`);
    schemas.push(isolated);
    await runMigrations(url ?? '', { schema: isolated });
    const pool = new pg.Pool({ connectionString: url, options: `-c search_path=${isolated}` });
    pools.push(pool);
    return pool;
  };

  it('AC-004-13: 20 параллельных reserve при бюджете роя на 5 резервов — ровно 5 ok, held 5000, 5 строк holds', async () => {
    const pool = newPool();
    const store = createPostgresBudgetStore(pool);
    const swarmId = randomUUID();
    expect(await store.register(registration(swarmId, 5000, AGENTS_8), NOW)).toBe(true);

    const results = await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        store.reserve(randomUUID(), { swarmId, agentId: `agent-${(index % 8) + 1}` }, 1000, NOW),
      ),
    );

    expect(results.filter((result) => result.ok)).toHaveLength(5);
    expect(
      results.filter((result) => !result.ok).map((result) => (result.ok ? '' : result.code)),
    ).toEqual(Array(15).fill('swarm_budget_exceeded'));
    expect(await heldOf(pool, swarmId)).toBe(5000);
    expect(await countRows(pool, 'budget_holds', swarmId)).toBe(5);
  });

  it('AC-004-13: 20 параллельных reserve при бюджете агента на 5 резервов — ровно 5 ok, held агента 5000', async () => {
    const pool = newPool();
    const store = createPostgresBudgetStore(pool);
    const swarmId = randomUUID();
    await store.register(
      registration(swarmId, 100_000, [{ agentId: 'agent-1', budgetMicroUsd: 5000 }]),
      NOW,
    );

    const results = await Promise.all(
      Array.from({ length: 20 }, () =>
        store.reserve(randomUUID(), { swarmId, agentId: 'agent-1' }, 1000, NOW),
      ),
    );

    expect(results.filter((result) => result.ok)).toHaveLength(5);
    expect(
      results.filter((result) => !result.ok).map((result) => (result.ok ? '' : result.code)),
    ).toEqual(Array(15).fill('agent_budget_exceeded'));
    const agent = await pool.query<{ held: string }>(
      'select held_micro_usd as held from swarm_agents where swarm_id = $1 and agent_id = $2',
      [swarmId, 'agent-1'],
    );
    expect(Number(agent.rows[0]?.held)).toBe(5000);
    expect(await heldOf(pool, swarmId)).toBe(5000);
    expect(await countRows(pool, 'budget_holds', swarmId)).toBe(5);
  });

  it('AC-004-13: закрытый рой не резервирует — swarm_budget_exceeded, held и holds не меняются', async () => {
    const pool = newPool();
    const store = createPostgresBudgetStore(pool);
    const swarmId = randomUUID();
    await store.register(registration(swarmId, 10_000), NOW);
    await store.close(swarmId, NOW);

    expect(await store.reserve(randomUUID(), { swarmId, agentId: 'agent-1' }, 1000, NOW)).toEqual({
      ok: false,
      code: 'swarm_budget_exceeded',
    });
    expect(await heldOf(pool, swarmId)).toBe(0);
    expect(await countRows(pool, 'budget_holds', swarmId)).toBe(0);
  });

  it('AC-004-13: резерв агента, которого нет в swarm_agents, — agent_budget_exceeded, резерв роя откатан', async () => {
    const pool = newPool();
    const store = createPostgresBudgetStore(pool);
    const swarmId = randomUUID();
    await store.register(registration(swarmId, 10_000), NOW);

    expect(await store.reserve(randomUUID(), { swarmId, agentId: 'agent-9' }, 1000, NOW)).toEqual({
      ok: false,
      code: 'agent_budget_exceeded',
    });
    expect(await heldOf(pool, swarmId)).toBe(0);
    expect(await countRows(pool, 'budget_holds', swarmId)).toBe(0);
  });

  it('AC-004-14: settle резерва 1000 списанием 700 — резерв удалён, held −1000, spent +700, одна запись ledger; повтор ничего не меняет', async () => {
    const pool = newPool();
    const store = createPostgresBudgetStore(pool);
    const swarmId = randomUUID();
    const callId = randomUUID();
    await store.register(
      registration(swarmId, 10_000, [{ agentId: 'agent-1', budgetMicroUsd: 5000 }]),
      NOW,
    );
    expect(await store.reserve(callId, { swarmId, agentId: 'agent-1' }, 1000, NOW)).toEqual({
      ok: true,
    });

    const settled = entry(callId, swarmId, 'agent-1', 700, { providerCostMicroUsd: 650 });
    await store.settle(settled);

    expect(await countRows(pool, 'budget_holds', swarmId)).toBe(0);
    const swarm = await pool.query<{ held: string; spent: string }>(
      'select held_micro_usd as held, spent_micro_usd as spent from swarm_budgets where swarm_id = $1',
      [swarmId],
    );
    expect(swarm.rows[0]).toEqual({ held: '0', spent: '700' });
    const agent = await pool.query<{ held: string; spent: string }>(
      'select held_micro_usd as held, spent_micro_usd as spent from swarm_agents where swarm_id = $1',
      [swarmId],
    );
    expect(agent.rows[0]).toEqual({ held: '0', spent: '700' });
    const ledger = await pool.query<Record<string, unknown>>(
      `select call_id, ts, kind, swarm_id, agent_id, model, amount_micro_usd, basis, provider_cost_micro_usd
         from ledger_entries where call_id = $1`,
      [callId],
    );
    expect(ledger.rows).toHaveLength(1);
    expect(ledger.rows[0]).toEqual({
      call_id: callId,
      ts: new Date('2026-10-30T10:00:01.000Z'),
      kind: 'llm',
      swarm_id: swarmId,
      agent_id: 'agent-1',
      model: 'chat-small',
      amount_micro_usd: '700',
      basis: 'usage',
      provider_cost_micro_usd: '650',
    });

    await store.settle(settled);
    expect(await countRows(pool, 'ledger_entries', swarmId)).toBe(1);
    const again = await pool.query<{ spent: string }>(
      'select spent_micro_usd as spent from swarm_budgets where swarm_id = $1',
      [swarmId],
    );
    expect(again.rows[0]?.spent).toBe('700');
  });

  it('AC-004-14: параллельный повтор settle по одному callId списывает один раз — spent +700, одна запись ledger, held 0', async () => {
    const pool = newPool();
    const store = createPostgresBudgetStore(pool);
    const swarmId = randomUUID();
    const callId = randomUUID();
    await store.register(
      registration(swarmId, 10_000, [{ agentId: 'agent-1', budgetMicroUsd: 5000 }]),
      NOW,
    );
    await store.reserve(callId, { swarmId, agentId: 'agent-1' }, 1000, NOW);

    const settled = entry(callId, swarmId, 'agent-1', 700);
    await Promise.all([store.settle(settled), store.settle(settled)]);

    expect(await heldOf(pool, swarmId)).toBe(0);
    expect(await countRows(pool, 'ledger_entries', swarmId)).toBe(1);
    const spent = await pool.query<{ swarm: string; agent: string }>(
      `select b.spent_micro_usd as swarm, a.spent_micro_usd as agent
         from swarm_budgets b join swarm_agents a on a.swarm_id = b.swarm_id
        where b.swarm_id = $1`,
      [swarmId],
    );
    expect(spent.rows[0]).toEqual({ swarm: '700', agent: '700' });
  });

  it('AC-004-14: settle без резерва (освобождён при старте) — трата и запись ledger пишутся, held не меняется', async () => {
    const pool = newPool();
    const store = createPostgresBudgetStore(pool);
    const swarmId = randomUUID();
    await store.register(registration(swarmId, 10_000), NOW);

    await store.settle(entry(randomUUID(), swarmId, 'agent-1', 300));

    const swarm = await pool.query<{ held: string; spent: string }>(
      'select held_micro_usd as held, spent_micro_usd as spent from swarm_budgets where swarm_id = $1',
      [swarmId],
    );
    expect(swarm.rows[0]).toEqual({ held: '0', spent: '300' });
    expect(await countRows(pool, 'ledger_entries', swarmId)).toBe(1);
  });

  it('AC-004-18: releaseHolds удаляет два резерва, уменьшает held роя и агентов на их суммы, записей ledger нет', async () => {
    const pool = await isolatedPool();
    const store = createPostgresBudgetStore(pool);
    const swarmId = randomUUID();
    await store.register(
      registration(swarmId, 10_000, [
        { agentId: 'agent-1', budgetMicroUsd: 5000 },
        { agentId: 'agent-2' },
      ]),
      NOW,
    );
    await store.reserve(randomUUID(), { swarmId, agentId: 'agent-1' }, 1000, NOW);
    await store.reserve(randomUUID(), { swarmId, agentId: 'agent-2' }, 2000, NOW);
    expect(await heldOf(pool, swarmId)).toBe(3000);

    const released = await store.releaseHolds();

    expect(released.map((hold) => hold.amountMicroUsd).sort((a, b) => a - b)).toEqual([1000, 2000]);
    expect(released.every((hold) => hold.swarmId === swarmId)).toBe(true);
    expect(await countRows(pool, 'budget_holds', swarmId)).toBe(0);
    expect(await heldOf(pool, swarmId)).toBe(0);
    const agents = await pool.query<{ held: string }>(
      'select held_micro_usd as held from swarm_agents where swarm_id = $1 order by agent_id',
      [swarmId],
    );
    expect(agents.rows.map((row) => Number(row.held))).toEqual([0, 0]);
    expect(await countRows(pool, 'ledger_entries', swarmId)).toBe(0);
  });

  it('AC-004-14: гонка settle и releaseHolds по одному резерву — held не уходит в минус, итог 0, одна запись ledger', async () => {
    const pool = await isolatedPool();
    const store = createPostgresBudgetStore(pool);
    const swarmId = randomUUID();
    const callId = randomUUID();
    await store.register(registration(swarmId, 10_000), NOW);
    await store.reserve(callId, { swarmId, agentId: 'agent-1' }, 1000, NOW);

    await Promise.all([store.settle(entry(callId, swarmId, 'agent-1', 700)), store.releaseHolds()]);

    expect(await heldOf(pool, swarmId)).toBe(0);
    expect(await countRows(pool, 'budget_holds', swarmId)).toBe(0);
    const agent = await pool.query<{ held: string; spent: string }>(
      'select held_micro_usd as held, spent_micro_usd as spent from swarm_agents where swarm_id = $1',
      [swarmId],
    );
    expect(agent.rows[0]).toEqual({ held: '0', spent: '700' });
    expect(await countRows(pool, 'ledger_entries', swarmId)).toBe(1);
  });

  it('AC-004-32: ledgerReport по рою и по since — суммы и счётчики по basis, провайдерская стоимость только по вызовам с фактом', async () => {
    const pool = newPool();
    const store = createPostgresBudgetStore(pool);
    const swarmA = randomUUID();
    const swarmB = randomUUID();
    await store.register(registration(swarmA, 10_000), NOW);
    await store.register(registration(swarmB, 10_000), NOW);
    const entries = [
      entry(randomUUID(), swarmA, 'agent-1', 100, {
        providerCostMicroUsd: 90,
        ts: '2026-10-30T10:00:00.000Z',
      }),
      entry(randomUUID(), swarmA, 'agent-1', 200, { ts: '2026-10-30T11:00:00.000Z' }),
      entry(randomUUID(), swarmA, 'agent-1', 50, {
        basis: 'estimate',
        ts: '2026-10-30T12:00:00.000Z',
      }),
      entry(randomUUID(), swarmA, 'agent-1', 0, { basis: 'none', ts: '2026-10-30T13:00:00.000Z' }),
      entry(randomUUID(), swarmA, 'agent-1', 300, {
        providerCostMicroUsd: 310,
        ts: '2026-10-29T09:00:00.000Z',
      }),
      entry(randomUUID(), swarmB, 'agent-1', 40, {
        providerCostMicroUsd: 35,
        ts: '2026-10-30T11:30:00.000Z',
      }),
    ];
    for (const item of entries) await store.settle(item);

    expect(await ledgerReport(pool, { swarmId: swarmA })).toEqual({
      calls: 5,
      chargedMicroUsd: 650,
      byBasis: {
        usage: { calls: 3, microUsd: 600 },
        estimate: { calls: 1, microUsd: 50 },
        none: { calls: 1, microUsd: 0 },
      },
      providerCostMicroUsd: 400,
      callsWithoutProviderCost: 3,
      chargedWithProviderCostMicroUsd: 400,
    });
    expect(
      await ledgerReport(pool, { swarmId: swarmA, since: new Date('2026-10-30T00:00:00.000Z') }),
    ).toEqual({
      calls: 4,
      chargedMicroUsd: 350,
      byBasis: {
        usage: { calls: 2, microUsd: 300 },
        estimate: { calls: 1, microUsd: 50 },
        none: { calls: 1, microUsd: 0 },
      },
      providerCostMicroUsd: 90,
      callsWithoutProviderCost: 3,
      chargedWithProviderCostMicroUsd: 100,
    });
    expect(await ledgerReport(pool, { swarmId: swarmB })).toEqual({
      calls: 1,
      chargedMicroUsd: 40,
      byBasis: {
        usage: { calls: 1, microUsd: 40 },
        estimate: { calls: 0, microUsd: 0 },
        none: { calls: 0, microUsd: 0 },
      },
      providerCostMicroUsd: 35,
      callsWithoutProviderCost: 0,
      chargedWithProviderCostMicroUsd: 40,
    });
  });

  it('AC-004-40: createPostgresPriceStore — "3.0000" в БД читается как "3", повторный save обновляет строку', async () => {
    const store = createPostgresPriceStore(newPool());
    const model = (
      input: string,
    ): {
      openRouterModel: string;
      prices: { inputPerMTokUsd: string; cachedInputPerMTokUsd: string; outputPerMTokUsd: string };
      updatedAt: Date;
    } => ({
      openRouterModel: 'vendor/chat-small',
      prices: { inputPerMTokUsd: input, cachedInputPerMTokUsd: '0.3', outputPerMTokUsd: '15' },
      updatedAt: NOW,
    });

    await store.save([model('3')]);
    expect(await store.load()).toEqual([model('3')]);

    await store.save([model('2.5')]);
    expect(await store.load()).toEqual([model('2.5')]);
  });

  it('close и findAgent: findAgent отдаёт модель и срок; повтор close отдаёт тот же spent; роя нет — null; register повтора — false', async () => {
    const pool = newPool();
    const store = createPostgresBudgetStore(pool);
    const swarmId = randomUUID();
    await store.register(
      registration(swarmId, 10_000, [{ agentId: 'agent-1' }], '2026-10-30T09:00:00.000Z'),
      NOW,
    );
    expect(await store.register(registration(swarmId, 10_000), NOW)).toBe(false);

    expect(await store.findAgent(swarmId, 'agent-1')).toEqual({
      model: 'chat-small',
      expiresAt: new Date('2026-10-30T09:00:00.000Z'),
      closed: false,
    });
    expect(await store.findAgent(swarmId, 'agent-9')).toBeNull();

    await store.settle(entry(randomUUID(), swarmId, 'agent-1', 250));
    expect(await store.close(swarmId, NOW)).toEqual({ spentMicroUsd: 250, heldMicroUsd: 0 });
    expect(await store.close(swarmId, new Date('2026-10-30T12:00:00.000Z'))).toEqual({
      spentMicroUsd: 250,
      heldMicroUsd: 0,
    });
    expect((await store.findAgent(swarmId, 'agent-1'))?.closed).toBe(true);
    expect(await store.close(randomUUID(), NOW)).toBeNull();
  });

  it('AC-013-18: close отдаёт heldMicroUsd идущего резерва, totals — spent и held; роя нет и не UUID — null', async () => {
    const pool = newPool();
    const store = createPostgresBudgetStore(pool);
    const swarmId = randomUUID();
    await store.register(registration(swarmId, 10_000), NOW);
    await store.settle(entry(randomUUID(), swarmId, 'agent-1', 250));
    expect(await store.reserve(randomUUID(), { swarmId, agentId: 'agent-1' }, 300, NOW)).toEqual({
      ok: true,
    });

    expect(await store.totals(swarmId)).toEqual({ spentMicroUsd: 250, heldMicroUsd: 300 });
    expect(await store.close(swarmId, NOW)).toEqual({ spentMicroUsd: 250, heldMicroUsd: 300 });
    expect(await store.totals(swarmId)).toEqual({ spentMicroUsd: 250, heldMicroUsd: 300 });
    expect(await store.totals(randomUUID())).toBeNull();
    expect(await store.totals('not-a-uuid')).toBeNull();
  });
});
