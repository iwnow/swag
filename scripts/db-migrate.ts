// Миграции схемы с хоста: спека 003, 4.6. Адрес базы — как у infra:check.
import { runMigrations } from '@swag/adapter-postgres';
import { BaseConfig, ConfigError, loadConfig } from '@swag/config';
import { onHost } from './host-url.ts';

function readDatabaseUrl(): string {
  try {
    return loadConfig(BaseConfig.pick({ DATABASE_URL: true })).DATABASE_URL;
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error(`${error.message}\nСкопируйте .env.example в .env.`);
      process.exit(1);
    }
    throw error;
  }
}

await runMigrations(onHost(readDatabaseUrl()));
console.log('db:migrate: миграции применены');
