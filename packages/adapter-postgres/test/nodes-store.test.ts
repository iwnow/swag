import { randomUUID } from 'node:crypto';
import { createAesGcmCipher } from '@swag/adapter-crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPostgresNodeState, createPostgresSecretStore, runMigrations } from '../src/index.ts';

// Спека 026, 4.5, 4.6, 4.10. Нужен запущенный Postgres: POSTGRES_TEST_URL из .env. Схема создаётся на время файла.
// Ключ и значения — явно фейковые.
const url = process.env['POSTGRES_TEST_URL'];

const KEY = Buffer.alloc(32, 1).toString('base64');
const NOW = new Date('2026-11-02T10:00:00.000Z');
const LATER = new Date('2026-11-02T11:00:00.000Z');
const TOKEN = 'fake-avito-token-012'; // 20 символов

describe.skipIf(!url)('adapter-postgres секреты организации и состояние узлов', () => {
  const schema = `test_${randomUUID().replaceAll('-', '')}`;
  const cipher = createAesGcmCipher(KEY);
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

  // Организация и администратор для внешних ключей org_secrets и node_state.
  const seedOrg = async (): Promise<{ orgId: string; userId: string }> => {
    const orgId = randomUUID();
    const userId = randomUUID();
    await pool.query('insert into organizations (id, name, created_at) values ($1, $2, now())', [
      orgId,
      `Организация ${orgId}`,
    ]);
    await pool.query(
      `insert into users (id, email, password_hash, role, org_id, created_at)
       values ($1, $2, 'hash', 'admin', $3, now())`,
      [userId, `${userId}@example.test`, orgId],
    );
    return { orgId, userId };
  };

  it('AC-026-6: put, list, read, повторный put, delete; значение не лежит открытым в таблице; hint по длине', async () => {
    const store = createPostgresSecretStore(pool, cipher);
    const { orgId, userId } = await seedOrg();
    const name = 'avito_token';
    expect(TOKEN).toHaveLength(20);

    const put = await store.put(orgId, name, TOKEN, userId, NOW);
    expect(put).toEqual({ name, hint: '-012', updatedAt: NOW.toISOString() });
    expect(await store.list(orgId)).toEqual([put]);
    expect(await store.read(orgId, [name])).toEqual({ [name]: TOKEN });

    const leak = await pool.query<{ p: number }>(
      `select strpos(convert_from(ciphertext, 'latin1'), $1::text) as p
         from org_secrets where org_id = $2 and name = $3`,
      [TOKEN, orgId, name],
    );
    expect(leak.rows[0]?.p).toBe(0);

    const replaced = await store.put(orgId, name, 'fake-avito-token-new-9999', userId, LATER);
    expect(replaced.hint).toBe('9999');
    expect(await store.read(orgId, [name])).toEqual({ [name]: 'fake-avito-token-new-9999' });
    expect(await store.list(orgId)).toEqual([replaced]);

    expect(await store.delete(orgId, name)).toBe(true);
    expect(await store.delete(orgId, name)).toBe(false);
    expect(await store.read(orgId, [name])).toEqual({});
  });

  it('AC-026-6: секрет из 10 символов — hint null; read с пустым списком имён отдаёт {}', async () => {
    const store = createPostgresSecretStore(pool, cipher);
    const { orgId, userId } = await seedOrg();

    const short = await store.put(orgId, 'short_key', 'short-val1', userId, NOW);
    expect(short.hint).toBeNull();
    expect(await store.read(orgId, [])).toEqual({});
  });

  it('AC-026-6: шифротекст привязан к организации и имени — чужое имя не расшифровывается', async () => {
    const store = createPostgresSecretStore(pool, cipher);
    const { orgId, userId } = await seedOrg();
    await store.put(orgId, 'avito_token', TOKEN, userId, NOW);
    await pool.query(
      `update org_secrets set name = 'other_name' where org_id = $1 and name = 'avito_token'`,
      [orgId],
    );

    await expect(store.read(orgId, ['other_name'])).rejects.toThrow();
  });

  it('AC-026-18: одинаковый key под двумя orgId и двумя stateKey — четыре значения независимы; set(null) удаляет только свою строку', async () => {
    const state = createPostgresNodeState(pool);
    const first = await seedOrg();
    const second = await seedOrg();
    const key = 'cursor';

    await state.set(first.orgId, 'node-a', key, 'a', NOW);
    await state.set(first.orgId, 'node-b', key, 'b', NOW);
    await state.set(second.orgId, 'node-a', key, 'c', NOW);
    await state.set(second.orgId, 'node-b', key, 'd', NOW);
    expect(await state.get(first.orgId, 'node-a', key)).toBe('a');
    expect(await state.get(first.orgId, 'node-b', key)).toBe('b');
    expect(await state.get(second.orgId, 'node-a', key)).toBe('c');
    expect(await state.get(second.orgId, 'node-b', key)).toBe('d');

    await state.set(first.orgId, 'node-a', key, null, LATER);
    expect(await state.get(first.orgId, 'node-a', key)).toBeNull();
    expect(await state.get(first.orgId, 'node-b', key)).toBe('b');
    expect(await state.get(second.orgId, 'node-a', key)).toBe('c');
    expect(await state.get(second.orgId, 'node-b', key)).toBe('d');

    await state.set(first.orgId, 'node-b', key, 'e', LATER);
    expect(await state.get(first.orgId, 'node-b', key)).toBe('e');
    const rows = await pool.query<{ n: number }>(
      'select count(*)::int as n from node_state where org_id = $1',
      [first.orgId],
    );
    expect(rows.rows[0]?.n).toBe(1);
  });
});
