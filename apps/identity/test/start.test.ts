import { randomUUID, generateKeyPairSync } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createNodeOpaqueTokens, createArgon2Hasher } from '@swag/adapter-crypto';
import { createPostgresIdentityStore, runMigrations } from '@swag/adapter-postgres';
import { createMemoryMailer, createMemoryRateLimiter } from '@swag/adapter-memory';
import { createMemoryExporters, startTelemetry } from '@swag/adapter-telemetry';
import type { IdentityCoreDeps } from '@swag/identity-core';
import { jwtKeys, startIdentityCore, startOrExit } from '../src/start.ts';
import { PASSWORD } from './support.ts';

// Нужен запущенный Postgres: POSTGRES_TEST_URL (compose или сервис в CI). Каждый сценарий — своя схема.
const url = process.env['POSTGRES_TEST_URL'];

const silent = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

const privateKeyBase64 = Buffer.from(
  generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }),
).toString('base64');

function deps(
  supervisor: IdentityCoreDeps['settings']['supervisor'],
): Omit<IdentityCoreDeps, 'store'> {
  return {
    version: 'test',
    ...jwtKeys({ privateKeyBase64, kid: 'test-1' }),
    hasher: createArgon2Hasher(),
    opaque: createNodeOpaqueTokens(),
    mailer: createMemoryMailer(),
    limiter: createMemoryRateLimiter({ now: () => Date.now() }),
    clock: { now: () => Date.now() },
    ids: { uuid: () => randomUUID() },
    log: silent,
    settings: {
      confirmUrl: 'http://127.0.0.1:4200/auth/confirm',
      accessTtlS: 900,
      refreshTtlS: 2592000,
      confirmTtlS: 86400,
      supervisor,
    },
  };
}

describe.skipIf(!url)('старт identity на Postgres', () => {
  const schemas = [
    `test_${randomUUID().replaceAll('-', '')}`,
    `test_${randomUUID().replaceAll('-', '')}`,
  ];
  const [created, taken] = schemas as [string, string];
  let admin: pg.Client;

  beforeAll(async () => {
    admin = new pg.Client({ connectionString: url ?? '' });
    await admin.connect();
    for (const schema of schemas) await admin.query(`create schema ${schema}`);
  });

  afterAll(async () => {
    for (const schema of schemas) await admin.query(`drop schema ${schema} cascade`);
    await admin.end();
  });

  it('REQ-012-23: старт применяет миграции и создаёт супервизора один раз (AC-012-20, оболочка)', async () => {
    const supervisor = { email: 'root@example.com', password: PASSWORD };
    const first = await startIdentityCore(
      { databaseUrl: url ?? '', schema: created },
      deps(supervisor),
    );
    const tables = await first.pool.query<{ table_name: string }>(
      `select table_name from information_schema.tables where table_schema = $1`,
      [created],
    );
    expect(tables.rows.map((row) => row.table_name)).toEqual(
      expect.arrayContaining(['users', 'organizations', 'sessions', 'email_confirmations']),
    );
    await first.pool.end();

    const second = await startIdentityCore(
      { databaseUrl: url ?? '', schema: created },
      deps(supervisor),
    );
    const rows = await second.pool.query<{ role: string; org_id: string | null }>(
      `select role, org_id from users where email = $1`,
      [supervisor.email],
    );
    expect(rows.rows).toEqual([{ role: 'supervisor', org_id: null }]);
    await second.pool.end();
  });

  it('AC-012-20: занятый email супервизора — startOrExit вызывает exit(1) и пишет одну запись error', async () => {
    await runMigrations(url ?? '', { schema: taken });
    const pool = new pg.Pool({
      connectionString: url,
      options: `-c search_path=${taken}`,
    });
    const store = createPostgresIdentityStore(pool);
    const now = Date.now();
    const orgId = randomUUID();
    const email = 'root@example.com';
    await store.addConfirmation({
      tokenHash: 'a'.repeat(64),
      email,
      expiresAt: now + 60000,
      createdAt: now,
    });
    await store.confirmRegistration({
      tokenHash: 'a'.repeat(64),
      now,
      org: { id: orgId, name: 'Компания', createdAt: now },
      user: { id: randomUUID(), passwordHash: 'x', role: 'admin', orgId, createdAt: now },
    });
    await pool.end();

    const lines: string[] = [];
    const memory = createMemoryExporters();
    const telemetry = startTelemetry({
      service: 'identity',
      version: 'test',
      otlpEndpoint: null,
      logLevel: 'debug',
      flushTimeoutMs: 2000,
      stdout: (line) => lines.push(line),
      exporters: { spans: memory.spans, logs: memory.logs },
    });
    const exit = vi.fn();
    await expect(
      startOrExit(
        { databaseUrl: url ?? '', schema: taken },
        { ...deps({ email, password: PASSWORD }), log: telemetry.logger },
        exit,
      ),
    ).rejects.toThrow('supervisor email taken');
    await telemetry.shutdown();

    expect(exit).toHaveBeenCalledWith(1);
    const errors = lines
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((record) => record['level'] === 'error');
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ msg: 'startup failed' });
  });
});
