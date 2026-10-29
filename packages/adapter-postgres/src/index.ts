import { fileURLToPath } from 'node:url';
import { runner } from 'node-pg-migrate';

const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));

/** Применяет миграции из `migrations/` пакета (спека 003, 4.4, REQ-003-5). Повторный вызов ничего не меняет. */
export async function runMigrations(
  databaseUrl: string,
  options: { schema?: string } = {},
): Promise<void> {
  const schema = options.schema ?? 'public';
  await runner({
    databaseUrl,
    dir: MIGRATIONS_DIR,
    direction: 'up',
    schema,
    migrationsSchema: schema,
    migrationsTable: 'pgmigrations',
    log: () => undefined,
  });
}
