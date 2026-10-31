import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../src/index.ts';

// Нужен запущенный Postgres: POSTGRES_TEST_URL (compose или сервис в CI). Схема создаётся на время теста.
const url = process.env['POSTGRES_TEST_URL'];

describe.skipIf(!url)('adapter-postgres миграции', () => {
  const schema = `test_${randomUUID().replaceAll('-', '')}`;
  let client: pg.Client;

  const tables = async (): Promise<string[]> => {
    const result = await client.query<{ table_name: string }>(
      `select table_name from information_schema.tables
        where table_schema = $1 and table_type = 'BASE TABLE' order by table_name`,
      [schema],
    );
    return result.rows.map((row) => row.table_name);
  };

  const migrationRows = async (): Promise<number> => {
    const result = await client.query<{ count: string }>(
      `select count(*) as count from ${schema}.pgmigrations`,
    );
    return Number(result.rows[0]?.count);
  };

  beforeAll(async () => {
    client = new pg.Client({ connectionString: url ?? '' });
    await client.connect();
    await client.query(`create schema ${schema}`);
  });

  afterAll(async () => {
    await client.query(`drop schema ${schema} cascade`);
    await client.end();
  });

  it('AC-003-1: таблицы swarms и swarm_events создаются, повторный запуск ничего не меняет', async () => {
    await runMigrations(url ?? '', { schema });
    const afterFirst = await tables();
    const rowsAfterFirst = await migrationRows();

    expect(afterFirst).toEqual(expect.arrayContaining(['swarm_events', 'swarms']));
    expect(rowsAfterFirst).toBe(3); // 0001_swarms, 0002_money и 0003_identity

    await expect(runMigrations(url ?? '', { schema })).resolves.toBeUndefined();

    expect(await tables()).toEqual(afterFirst);
    expect(await migrationRows()).toBe(rowsAfterFirst);
  });

  it('AC-004-20: миграция 0002 создаёт таблицы 4.5 с колонками и ограничениями; параллельный запуск без ошибок', async () => {
    const fresh = `test_${randomUUID().replaceAll('-', '')}`;
    await client.query(`create schema ${fresh}`);
    try {
      await Promise.all([
        runMigrations(url ?? '', { schema: fresh }),
        runMigrations(url ?? '', { schema: fresh }),
      ]);

      const columns = await client.query<{ table_name: string; column_name: string }>(
        `select table_name, column_name from information_schema.columns
          where table_schema = $1 order by table_name, ordinal_position`,
        [fresh],
      );
      const byTable: Record<string, string[]> = {};
      for (const row of columns.rows) {
        (byTable[row.table_name] ??= []).push(row.column_name);
      }
      expect(byTable).toEqual({
        budget_holds: ['call_id', 'swarm_id', 'agent_id', 'amount_micro_usd', 'created_at'],
        email_confirmations: ['token_hash', 'email', 'expires_at', 'used_at', 'created_at'],
        organizations: ['id', 'name', 'created_at'],
        ledger_entries: [
          'call_id',
          'ts',
          'kind',
          'swarm_id',
          'agent_id',
          'model',
          'amount_micro_usd',
          'basis',
          'provider_cost_micro_usd',
        ],
        model_prices: [
          'open_router_model',
          'input_per_mtok_usd',
          'cached_input_per_mtok_usd',
          'output_per_mtok_usd',
          'updated_at',
        ],
        pgmigrations: expect.any(Array),
        sessions: [
          'id',
          'user_id',
          'refresh_hash',
          'previous_hash',
          'expires_at',
          'revoked_at',
          'created_at',
        ],
        users: ['id', 'email', 'password_hash', 'role', 'org_id', 'created_at'],
        swarm_agents: [
          'swarm_id',
          'agent_id',
          'model',
          'budget_micro_usd',
          'spent_micro_usd',
          'held_micro_usd',
        ],
        swarm_budgets: [
          'swarm_id',
          'budget_micro_usd',
          'spent_micro_usd',
          'held_micro_usd',
          'created_at',
          'expires_at',
          'closed_at',
        ],
        swarm_events: expect.any(Array),
        swarms: expect.any(Array),
      });

      const swarmId = randomUUID();
      await client.query(
        `insert into ${fresh}.swarm_budgets (swarm_id, budget_micro_usd, created_at) values ($1, 1000, now())`,
        [swarmId],
      );
      await expect(
        client.query(
          `insert into ${fresh}.swarm_budgets (swarm_id, budget_micro_usd, created_at) values ($1, 0, now())`,
          [randomUUID()],
        ),
      ).rejects.toThrow(/check/);
      await expect(
        client.query(
          `insert into ${fresh}.ledger_entries (call_id, ts, kind, swarm_id, agent_id, model, amount_micro_usd, basis)
           values ($1, now(), 'llm', $2, 'agent-1', 'chat-small', 1, 'bogus')`,
          [randomUUID(), swarmId],
        ),
      ).rejects.toThrow(/check/);
    } finally {
      await client.query(`drop schema ${fresh} cascade`);
    }
  });
  it('AC-012-3: миграция 0003 создаёт таблицы identity с ограничениями; повторный запуск ничего не меняет', async () => {
    await runMigrations(url ?? '', { schema });
    const tablesBefore = await tables();
    const rowsBefore = await migrationRows();
    const orgId = randomUUID();
    await client.query(
      `insert into ${schema}.organizations (id, name, created_at) values ($1, 'Магазин', now())`,
      [orgId],
    );
    const insertUser = (role: string, org: string | null, email: string) =>
      client.query(
        `insert into ${schema}.users (id, email, password_hash, role, org_id, created_at)
         values ($1, $2, 'hash', $3, $4, now())`,
        [randomUUID(), email, role, org],
      );

    await expect(insertUser('supervisor', orgId, 'sup-a@swag.local')).rejects.toThrow(/check/);
    await expect(insertUser('admin', null, 'admin-a@swag.local')).rejects.toThrow(/check/);
    await insertUser('admin', orgId, 'admin-b@swag.local');
    await expect(insertUser('user', orgId, 'admin-b@swag.local')).rejects.toThrow(
      /unique|duplicate/,
    );
    await insertUser('supervisor', null, 'sup-b@swag.local');

    await runMigrations(url ?? '', { schema });
    expect(await tables()).toEqual(tablesBefore);
    expect(await migrationRows()).toBe(rowsBefore);
  });
});
