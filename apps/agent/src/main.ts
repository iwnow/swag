import { createRequire } from 'node:module';
import { connectNatsBus } from '@swag/adapter-nats';
import { startTelemetry } from '@swag/adapter-telemetry';
import { startAgentProcess } from './start.ts';

const { version } = createRequire(import.meta.url)('../package.json') as { version: string };

const agent = await startAgentProcess({
  env: process.env,
  version,
  startTelemetry,
  connect: connectNatsBus,
  exit: (code) => process.exit(code),
});

// REQ-001-17: по SIGTERM закрыть соединение с NATS и выйти с кодом 0; телеметрия сбрасывается (REQ-016-8).
process.once('SIGTERM', () => void agent?.stop().then(() => process.exit(0)));
