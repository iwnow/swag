import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { balanceStoreContract } from '../../adapter-memory/test/balance-store.contract.ts';
import { createPostgresBalanceStore, runMigrations } from '../src/index.ts';

// Нужен запущенный Postgres: POSTGRES_TEST_URL из .env. Схема создаётся на время файла (спека 013, 4.2).
const url = process.env['POSTGRES_TEST_URL'];
const TS = '2026-11-01T10:00:00.000Z';

describe.skipIf(!url)('adapter-postgres хранилище баланса', () => {
  const schema = `test_${randomUUID().replaceAll('-', '')}`;
  let admin: pg.Client;
  let pool: pg.Pool;

  beforeAll(async () => {
    admin = new pg.Client({ connectionString: url ?? '' });
    await admin.connect();
    await admin.query(`create schema ${schema}`);
    await runMigrations(url ?? '', { schema });
    pool = new pg.Pool({ connectionString: url, max: 20, options: `-c search_path=${schema}` });
  });

  afterAll(async () => {
    await pool.end();
    await admin.query(`drop schema ${schema} cascade`);
    await admin.end();
  });

  balanceStoreContract('postgres', () => createPostgresBalanceStore(pool));

  it('AC-013-10: 10 параллельных резервов по 300 000 при остатке 1 000 000 — ровно 3 ok, баланс не меняется', async () => {
    const store = createPostgresBalanceStore(pool);
    const orgId = randomUUID();
    await store.topup({
      orgId,
      amountMicroUsd: 1_000_000,
      actorId: randomUUID(),
      comment: null,
      ts: TS,
    });

    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        store.reserve({ orgId, swarmId: randomUUID(), amountMicroUsd: 300_000, ts: TS }),
      ),
    );

    expect(results.filter((result) => result === 'ok')).toHaveLength(3);
    expect(results.filter((result) => result === 'insufficient')).toHaveLength(7);
    expect(await store.balance(orgId)).toEqual({
      balanceMicroUsd: 1_000_000,
      heldMicroUsd: 900_000,
    });
  });
});
