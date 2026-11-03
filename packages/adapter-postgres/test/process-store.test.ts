import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe } from 'vitest';
import { processStoreCases } from '../../adapter-memory/test/process-store.cases.ts';
import { createPostgresProcessStore, runMigrations } from '../src/index.ts';

// Нужен запущенный Postgres: POSTGRES_TEST_URL из .env. Схема создаётся на время файла (спека 033, 4.6, 4.8).
const url = process.env['POSTGRES_TEST_URL'];

describe.skipIf(!url)('adapter-postgres хранилище процессов', () => {
  const schema = `test_${randomUUID().replaceAll('-', '')}`;
  let admin: pg.Client;
  let pool: pg.Pool;

  beforeAll(async () => {
    admin = new pg.Client({ connectionString: url ?? '' });
    await admin.connect();
    await admin.query(`create schema ${schema}`);
    await runMigrations(url ?? '', { schema });
    pool = new pg.Pool({ connectionString: url, max: 10, options: `-c search_path=${schema}` });
  });

  afterAll(async () => {
    await pool.end();
    await admin.query(`drop schema ${schema} cascade`);
    await admin.end();
  });

  // Процессы ссылаются на organizations и users (внешние ключи 0007): автор создаётся в схеме каждый раз.
  processStoreCases(
    'postgres',
    () => createPostgresProcessStore(pool),
    async () => {
      const orgId = randomUUID();
      const userId = randomUUID();
      await pool.query('insert into organizations (id, name, created_at) values ($1, $2, now())', [
        orgId,
        'Процессы',
      ]);
      await pool.query(
        `insert into users (id, email, password_hash, role, org_id, created_at)
       values ($1, $2, 'hash', 'user', $3, now())`,
        [userId, `${userId}@swag.test`, orgId],
      );
      return { orgId, createdBy: userId };
    },
  );
});
