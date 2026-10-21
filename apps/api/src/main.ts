import { createRequire } from 'node:module';
import { createApiCore } from '@swag/api-core';
import { ApiConfig, ConfigError, loadConfig } from '@swag/config';
import { buildApp } from './app.ts';

function readConfig(): ApiConfig {
  try {
    return loadConfig(ApiConfig);
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error(error.message);
      process.exit(1);
    }
    throw error;
  }
}

const config = readConfig();
const { version } = createRequire(import.meta.url)('../package.json') as { version: string };
const app = buildApp(createApiCore({ version }), { logger: true });

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => void app.close().then(() => process.exit(0)));
}

await app.listen({ host: '0.0.0.0', port: config.API_PORT });
