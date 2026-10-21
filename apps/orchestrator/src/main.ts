import { createRequire } from 'node:module';
import { createOrchestratorCore } from '@swag/orchestrator-core';
import { OrchestratorConfig, ConfigError, loadConfig } from '@swag/config';
import { buildApp } from './app.ts';

function readConfig(): OrchestratorConfig {
  try {
    return loadConfig(OrchestratorConfig);
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
const app = buildApp(createOrchestratorCore({ version }), { logger: true });

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => void app.close().then(() => process.exit(0)));
}

await app.listen({ host: '0.0.0.0', port: config.ORCHESTRATOR_PORT });
