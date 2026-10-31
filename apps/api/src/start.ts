import { createApiCore, type ApiCore, type ApiCoreDeps, type Billing } from '@swag/api-core';
import type { FastifyInstance } from 'fastify';
import { createPostgresSwarmStore, runMigrations } from '@swag/adapter-postgres';
import pg from 'pg';
import type { RevocationSync } from './revocations.ts';

// Спека 003, 4.5 и спека 013, 4.9: миграции → пул → хранилище и billing → ядро → закрытие прерванных роёв → добор резервов. Один порядок для main.ts и тестов.
// `schema` задаёт схему для тестов (search_path); в работе не передаётся — схема public.
// `billing` получает пул, чтобы фабрика собрала хранилище баланса на том же пуле.
export async function startApiCore(
  options: { databaseUrl: string; schema?: string; billing: (pool: pg.Pool) => Billing },
  deps: Omit<ApiCoreDeps, 'store' | 'billing'>,
): Promise<{ core: ApiCore; pool: pg.Pool }> {
  const { databaseUrl, schema, billing } = options;
  try {
    await runMigrations(databaseUrl, { schema: schema ?? 'public' });
  } catch (error) {
    deps.log.error('migrations failed', { err: error });
    throw error;
  }
  const pool = new pg.Pool({
    connectionString: databaseUrl,
    options: schema === undefined ? undefined : `-c search_path=${schema}`,
  });
  try {
    const core = createApiCore({
      ...deps,
      store: createPostgresSwarmStore(pool),
      billing: billing(pool),
    });
    await core.closeInterrupted();
    await core.settlePending();
    return { core, pool };
  } catch (error) {
    await pool.end();
    throw error;
  }
}

// Спека 024, 4.12: listen только после первой удачной синхронизации отзывов; неудачная повторяется через pollMs.
export async function startServer(options: {
  app: FastifyInstance;
  revocations: RevocationSync;
  pollMs: number;
  host: string;
  port: number;
  wait?: (ms: number) => Promise<void>;
}): Promise<void> {
  const wait = options.wait ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  for (;;) {
    try {
      await options.revocations.start();
      break;
    } catch {
      await wait(options.pollMs);
    }
  }
  await options.app.listen({ host: options.host, port: options.port });
}
