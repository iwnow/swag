import { createJoseSigner, createJoseVerifier, publicKeyFromPrivate } from '@swag/adapter-jose';
import { createPostgresIdentityStore, runMigrations } from '@swag/adapter-postgres';
import {
  createIdentityCore,
  type IdentityCore,
  type IdentityCoreDeps,
  type TokenSigner,
  type TokenVerifier,
} from '@swag/identity-core';
import pg from 'pg';

// Спека 012, 4.11, REQ-012-15, REQ-012-23: миграции → пул → хранилище → ядро → супервизор → listen.
// Один порядок для main.ts и теста. При ошибке после создания пула пул закрывается до проброса.
// `schema` задаёт схему для тестов (search_path); в работе не передаётся — схема public.
export async function startIdentityCore(
  options: { databaseUrl: string; schema?: string },
  deps: Omit<IdentityCoreDeps, 'store'>,
): Promise<{ core: IdentityCore; pool: pg.Pool }> {
  const { databaseUrl, schema } = options;
  await runMigrations(databaseUrl, { schema: schema ?? 'public' });
  const pool = new pg.Pool({
    connectionString: databaseUrl,
    options: schema === undefined ? undefined : `-c search_path=${schema}`,
  });
  try {
    const core = createIdentityCore({ ...deps, store: createPostgresIdentityStore(pool) });
    await core.ensureSupervisor();
    return { core, pool };
  } catch (error) {
    await pool.end();
    throw error;
  }
}

// Спека 012, AC-012-20: ошибка старта — одна запись `error` `startup failed` и выход с кодом 1.
// `exit` в main.ts сбрасывает телеметрию и завершает процесс, поэтому её промис не возвращается; без выхода ошибка пробрасывается.
export async function startOrExit(
  options: { databaseUrl: string; schema?: string },
  deps: Omit<IdentityCoreDeps, 'store'>,
  exit: (code: number) => Promise<void> | void,
): Promise<{ core: IdentityCore; pool: pg.Pool }> {
  try {
    return await startIdentityCore(options, deps);
  } catch (error) {
    deps.log.error('startup failed', { err: error });
    await exit(1);
    throw error;
  }
}

// Спека 012, 4.7 и D-117: IDENTITY_JWT_PRIVATE_KEY — base64 от PKCS8 PEM; открытый ключ для проверки выводится из закрытого.
export function jwtKeys(options: { privateKeyBase64: string; kid: string }): {
  signer: TokenSigner;
  verifier: TokenVerifier;
} {
  const privateKeyPem = Buffer.from(options.privateKeyBase64, 'base64').toString('utf8');
  return {
    signer: createJoseSigner({ privateKeyPem, kid: options.kid }),
    verifier: createJoseVerifier({
      publicKeyPem: publicKeyFromPrivate(privateKeyPem),
      kid: options.kid,
    }),
  };
}
