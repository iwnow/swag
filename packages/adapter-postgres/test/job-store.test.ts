import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe } from 'vitest';
import { jobStoreCases } from '../../adapter-memory/test/job-store.cases.ts';
import { createPostgresJobStore, runMigrations } from '../src/index.ts';

// Нужен запущенный Postgres: POSTGRES_TEST_URL из .env. Схема создаётся на время файла (спека 033, 4.7, 4.8).
// Второй пул — второе соединение к той же схеме для проверки skip locked (AC-033-11).
const url = process.env['POSTGRES_TEST_URL'];

describe.skipIf(!url)('adapter-postgres хранилище заданий', () => {
  const schema = `test_${randomUUID().replaceAll('-', '')}`;
  let admin: pg.Client;
  let pool: pg.Pool;
  let second: pg.Pool;

  beforeAll(async () => {
    admin = new pg.Client({ connectionString: url ?? '' });
    await admin.connect();
    await admin.query(`create schema ${schema}`);
    await runMigrations(url ?? '', { schema });
    const options = `-c search_path=${schema}`;
    pool = new pg.Pool({ connectionString: url, max: 10, options });
    second = new pg.Pool({ connectionString: url, max: 10, options });
  });

  afterAll(async () => {
    await pool.end();
    await second.end();
    await admin.query(`drop schema ${schema} cascade`);
    await admin.end();
  });

  jobStoreCases(
    'postgres',
    () => createPostgresJobStore(pool),
    () => createPostgresJobStore(second),
  );
});
