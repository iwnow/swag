import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPostgresBudgetStore, ledgerReport, runMigrations } from '@swag/adapter-postgres';
import type { ChargeBasis } from '@swag/contracts';
import type { LedgerEntry } from '@swag/llm-gateway-core';
import { formatMoneyReport, parseMoneyReportArgs } from './money-report.ts';

// Нужен запущенный Postgres: POSTGRES_TEST_URL. Схема создаётся на время файла (спека 004, 4.5, 4.13).
const url = process.env['POSTGRES_TEST_URL'];
const BUDGET = 1_000_000;

const entry = (
  swarmId: string,
  amountMicroUsd: number,
  options: { basis?: ChargeBasis; providerCostMicroUsd?: number | null; ts: string },
): LedgerEntry => ({
  callId: randomUUID(),
  ts: options.ts,
  swarmId,
  agentId: 'agent-1',
  model: 'chat-small',
  kind: 'llm',
  amountMicroUsd,
  basis: options.basis ?? 'usage',
  providerCostMicroUsd: options.providerCostMicroUsd ?? null,
});

describe.skipIf(!url)('money:report на Postgres (спека 004, 4.13)', () => {
  const schema = `test_${randomUUID().replaceAll('-', '')}`;
  const pools: pg.Pool[] = [];
  let admin: pg.Client;

  const newPool = (): pg.Pool => {
    const pool = new pg.Pool({
      connectionString: url,
      max: 5,
      options: `-c search_path=${schema}`,
    });
    pools.push(pool);
    return pool;
  };

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

  const registerSwarm = async (pool: pg.Pool, swarmId: string) => {
    await createPostgresBudgetStore(pool).register(
      {
        swarmId,
        budgetMicroUsd: BUDGET,
        expiresAt: null,
        agents: [{ agentId: 'agent-1', model: 'chat-small', budgetMicroUsd: null }],
      },
      new Date('2026-10-30T10:00:00.000Z'),
    );
  };

  it('AC-004-32: строки money:report по рою и по since — суммы, счётчики, n/a при нулевом факте', async () => {
    const pool = newPool();
    const store = createPostgresBudgetStore(pool);
    const swarmA = randomUUID();
    const swarmB = randomUUID();
    const swarmC = randomUUID();
    for (const swarmId of [swarmA, swarmB, swarmC]) await registerSwarm(pool, swarmId);

    const entries = [
      entry(swarmA, 10_000, { providerCostMicroUsd: 9_000, ts: '2026-10-30T10:00:00.000Z' }),
      entry(swarmA, 20_000, { ts: '2026-10-30T11:00:00.000Z' }),
      entry(swarmA, 5_000, { basis: 'estimate', ts: '2026-10-30T12:00:00.000Z' }),
      entry(swarmA, 0, { basis: 'none', ts: '2026-10-30T13:00:00.000Z' }),
      entry(swarmA, 30_000, { providerCostMicroUsd: 30_600, ts: '2026-10-29T09:00:00.000Z' }),
      entry(swarmB, 4_000, { providerCostMicroUsd: 3_500, ts: '2026-10-30T11:30:00.000Z' }),
      entry(swarmC, 1_000, { ts: '2026-10-30T11:00:00.000Z' }),
    ];
    for (const item of entries) await store.settle(item);

    expect(formatMoneyReport(await ledgerReport(pool, { swarmId: swarmA }))).toBe(
      [
        'calls 5 · charged $0.0650 (usage 3 / $0.0600, estimate 1 / $0.0050, none 1 / $0.0000)',
        'provider $0.0396 по 2 вызовам · без факта 3',
        'charged vs provider по тем же вызовам: $0.0400 vs $0.0396 · +1.01%',
      ].join('\n'),
    );
    expect(
      formatMoneyReport(
        await ledgerReport(pool, { swarmId: swarmA, since: new Date('2026-10-30T00:00:00.000Z') }),
      ),
    ).toBe(
      [
        'calls 4 · charged $0.0350 (usage 2 / $0.0300, estimate 1 / $0.0050, none 1 / $0.0000)',
        'provider $0.0090 по 1 вызовам · без факта 3',
        'charged vs provider по тем же вызовам: $0.0100 vs $0.0090 · +11.11%',
      ].join('\n'),
    );
    expect(formatMoneyReport(await ledgerReport(pool, { swarmId: swarmB }))).toBe(
      [
        'calls 1 · charged $0.0040 (usage 1 / $0.0040, estimate 0, none 0)',
        'provider $0.0035 по 1 вызовам · без факта 0',
        'charged vs provider по тем же вызовам: $0.0040 vs $0.0035 · +14.29%',
      ].join('\n'),
    );
    expect(formatMoneyReport(await ledgerReport(pool, { swarmId: swarmC }))).toBe(
      [
        'calls 1 · charged $0.0010 (usage 1 / $0.0010, estimate 0, none 0)',
        'provider $0.0000 по 0 вызовам · без факта 1',
        'charged vs provider по тем же вызовам: $0.0000 vs $0.0000 · n/a',
      ].join('\n'),
    );
  });

  it('AC-004-32: пустой рой — нулевые счётчики и n/a', async () => {
    const pool = newPool();
    const empty = randomUUID();
    await registerSwarm(pool, empty);

    expect(formatMoneyReport(await ledgerReport(pool, { swarmId: empty }))).toBe(
      [
        'calls 0 · charged $0.0000 (usage 0, estimate 0, none 0)',
        'provider $0.0000 по 0 вызовам · без факта 0',
        'charged vs provider по тем же вызовам: $0.0000 vs $0.0000 · n/a',
      ].join('\n'),
    );
  });

  it('REQ-004-19: разбор --swarm и --since; неверный ввод — ошибка', () => {
    const swarmId = randomUUID();
    expect(parseMoneyReportArgs([])).toEqual({});
    expect(parseMoneyReportArgs(['--swarm', swarmId, '--since', '2026-10-30T00:00:00Z'])).toEqual({
      swarmId,
      since: new Date('2026-10-30T00:00:00Z'),
    });
    expect(() => parseMoneyReportArgs(['--swarm'])).toThrow('нужно значение');
    expect(() => parseMoneyReportArgs(['--swarm', 'не-uuid'])).toThrow('не uuid');
    expect(() => parseMoneyReportArgs(['--since', 'вчера'])).toThrow('не ISO-дата');
    expect(() => parseMoneyReportArgs(['--limit', '5'])).toThrow('неизвестный аргумент');
  });
});
