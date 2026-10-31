import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { identityStoreContract } from '../../adapter-memory/test/identity-store.contract.ts';
import { createPostgresIdentityStore, runMigrations } from '../src/index.ts';

// Нужен запущенный Postgres: POSTGRES_TEST_URL из .env. Схема создаётся на время файла (спека 012, 4.9).
const url = process.env['POSTGRES_TEST_URL'];

const NOW = 1_000_000;
const HOUR = 3_600_000;

describe.skipIf(!url)('adapter-postgres хранилище identity', () => {
  const schema = `test_${randomUUID().replaceAll('-', '')}`;
  let admin: pg.Client;
  let pool: pg.Pool;

  beforeAll(async () => {
    admin = new pg.Client({ connectionString: url ?? '' });
    await admin.connect();
    await admin.query(`create schema ${schema}`);
    await runMigrations(url ?? '', { schema });
    pool = new pg.Pool({ connectionString: url, options: `-c search_path=${schema}` });
  });

  afterAll(async () => {
    await pool.end();
    await admin.query(`drop schema ${schema} cascade`);
    await admin.end();
  });

  identityStoreContract('postgres', () => createPostgresIdentityStore(pool));

  it('AC-012-9: параллельное подтверждение одним токеном — ровно один ok, одна организация и один пользователь', async () => {
    const store = createPostgresIdentityStore(pool);
    const tokenHash = `tok-race-${randomUUID()}`;
    const email = `race-${randomUUID()}@example.test`;
    const orgName = `Гонка ${randomUUID()}`;
    await store.addConfirmation({ tokenHash, email, expiresAt: NOW + HOUR, createdAt: NOW });

    const attempts = Array.from({ length: 8 }, () => {
      const orgId = randomUUID();
      return store.confirmRegistration({
        tokenHash,
        now: NOW,
        org: { id: orgId, name: orgName, createdAt: NOW },
        user: {
          id: randomUUID(),
          passwordHash: 'hash',
          role: 'admin',
          orgId,
          createdAt: NOW,
          blockedAt: null,
          tokensValidAfter: null,
        },
      });
    });
    const results = await Promise.all(attempts);

    const statuses = results.map((result) => result.status);
    expect(statuses.filter((status) => status === 'ok')).toHaveLength(1);
    expect(statuses.filter((status) => status === 'invalid_token')).toHaveLength(7);
    const orgs = await pool.query<{ n: number }>(
      'select count(*)::int as n from organizations where name = $1',
      [orgName],
    );
    const users = await pool.query<{ n: number }>(
      'select count(*)::int as n from users where email = $1',
      [email],
    );
    expect(orgs.rows[0]?.n).toBe(1);
    expect(users.rows[0]?.n).toBe(1);
  });

  it('AC-024-5: параллельные rotateSession одним старым хэшем — один ok и один reused', async () => {
    const store = createPostgresIdentityStore(pool);
    for (let round = 0; round < 5; round++) {
      const userId = randomUUID();
      await store.createUser({
        id: userId,
        email: `rotate-${randomUUID()}@example.test`,
        passwordHash: 'hash',
        role: 'supervisor',
        orgId: null,
        createdAt: NOW,
        blockedAt: null,
        tokensValidAfter: null,
      });
      const oldHash = `race-old-${randomUUID()}`;
      await store.createSession({
        id: randomUUID(),
        userId,
        refreshHash: oldHash,
        expiresAt: NOW + HOUR,
        createdAt: NOW,
      });

      const results = await Promise.all([
        store.rotateSession({
          oldHash,
          newHash: `race-new-a-${randomUUID()}`,
          now: NOW + 1,
          expiresAt: NOW + HOUR,
        }),
        store.rotateSession({
          oldHash,
          newHash: `race-new-b-${randomUUID()}`,
          now: NOW + 1,
          expiresAt: NOW + HOUR,
        }),
      ]);
      expect(results.map((result) => result.status).sort()).toEqual(['ok', 'reused']);
    }
  });
});
