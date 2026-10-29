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
    expect(rowsAfterFirst).toBe(1);

    await expect(runMigrations(url ?? '', { schema })).resolves.toBeUndefined();

    expect(await tables()).toEqual(afterFirst);
    expect(await migrationRows()).toBe(rowsAfterFirst);
  });
});
