// Проверка локальной инфраструктуры с хоста: спека 000, раздел 4.7.
import { jetstreamManager } from '@nats-io/jetstream';
import { connect } from '@nats-io/transport-node';
import { ApiConfig, ConfigError, OrchestratorConfig, loadConfig } from '@swag/config';
import pg from 'pg';

const TIMEOUT_MS = 5000;

/** Адрес из сети compose → адрес на хосте: имя сервиса заменяется на 127.0.0.1, порт тот же. */
function onHost(url: string): string {
  const parsed = new URL(url);
  parsed.hostname = '127.0.0.1';
  return parsed.toString();
}

function readConfig() {
  try {
    return loadConfig(ApiConfig.extend(OrchestratorConfig.shape));
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error(`${error.message}\nСкопируйте .env.example в .env.`);
      process.exit(1);
    }
    throw error;
  }
}

const config = readConfig();

async function checkPostgres(): Promise<void> {
  const client = new pg.Client({
    connectionString: onHost(config.DATABASE_URL),
    connectionTimeoutMillis: TIMEOUT_MS,
  });
  await client.connect();
  try {
    await client.query('select 1');
  } finally {
    await client.end();
  }
}

async function checkNats(): Promise<void> {
  const url = new URL(config.NATS_URL);
  const nc = await connect({ servers: `127.0.0.1:${url.port}`, timeout: TIMEOUT_MS });
  try {
    const jsm = await jetstreamManager(nc);
    await jsm.getAccountInfo();
  } finally {
    await nc.close();
  }
}

async function checkHealth(port: number): Promise<void> {
  const response = await fetch(`http://127.0.0.1:${port}/health`, {
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (response.status !== 200) throw new Error(`HTTP ${response.status}`);
}

const checks: [string, () => Promise<void>][] = [
  ['postgres', checkPostgres],
  ['nats', checkNats],
  ['api', () => checkHealth(config.API_PORT)],
  ['orchestrator', () => checkHealth(config.ORCHESTRATOR_PORT)],
];

let failed = false;
for (const [name, check] of checks) {
  try {
    await check();
    console.log(`ok    ${name}`);
  } catch (error) {
    failed = true;
    console.log(`fail  ${name}: ${error instanceof Error ? error.message : String(error)}`);
  }
}
process.exit(failed ? 1 : 0);
