// Проверка локальной инфраструктуры с хоста: спека 000, раздел 4.7.
import { jetstreamManager } from '@nats-io/jetstream';
import { connect } from '@nats-io/transport-node';
import {
  ApiConfig,
  ConfigError,
  IdentityConfig,
  LlmGatewayConfig,
  ObservabilityConfig,
  OrchestratorConfig,
  UiConfig,
  loadConfig,
} from '@swag/config';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import pg from 'pg';
import { onHost } from './host-url.ts';

const TIMEOUT_MS = 5000;
const execFileAsync = promisify(execFile);

function readConfig() {
  try {
    return loadConfig(
      ApiConfig.extend(OrchestratorConfig.shape)
        .extend(UiConfig.shape)
        .extend(ObservabilityConfig.shape)
        .extend(LlmGatewayConfig.pick({ LLM_GATEWAY_PORT: true }).shape)
        .extend({ IDENTITY_PORT: IdentityConfig.shape.IDENTITY_PORT }),
    );
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error(`${error.message}\nСкопируйте .env.example в .env.`);
      process.exit(1);
    }
    throw error;
  }
}

const config = readConfig();
// Спека 012, 4.11: порт UI Mailpit — переменная compose, не входит в IdentityConfig.
function readMailpitUiPort(): number {
  const port = Number(process.env['MAILPIT_UI_PORT']);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    console.error('MAILPIT_UI_PORT должен быть целым числом от 1 до 65535 (см. .env).');
    process.exit(1);
  }
  return port;
}
const mailpitUiPort = readMailpitUiPort();

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

async function checkHttp(port: number, path: string): Promise<void> {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (response.status !== 200) throw new Error(`HTTP ${response.status}`);
}

/** Спека 002, 4.9: `/health` gateway отдаёт `service: 'llm-gateway'`. */
async function checkLlmGateway(port: number): Promise<void> {
  const response = await fetch(`http://127.0.0.1:${port}/health`, {
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (response.status !== 200) throw new Error(`HTTP ${response.status}`);
  const body = (await response.json()) as { service?: unknown };
  if (body.service !== 'llm-gateway') throw new Error(`service ${String(body.service)}`);
}

/** Сервис без опубликованного порта (оркестратор, Q-7 спеки 001) проверяется изнутри своего контейнера. */
async function checkHttpInContainer(service: string, port: number, path: string): Promise<void> {
  await execFileAsync(
    'docker',
    ['compose', 'exec', '-T', service, 'wget', '-qO-', `http://127.0.0.1:${port}${path}`],
    { timeout: TIMEOUT_MS },
  );
}

/**
 * Collector (спека 016, 4.9): порты не публикуются, а образ distroless — без shell и wget. Поэтому
 * health_check extension Collector опрашивается из сети compose, изнутри контейнера api (там есть wget).
 */
async function checkCollector(): Promise<void> {
  await execFileAsync(
    'docker',
    ['compose', 'exec', '-T', 'api', 'wget', '-qO-', 'http://otel-collector:13133/'],
    { timeout: TIMEOUT_MS },
  );
}

const checks: [string, () => Promise<void>][] = [
  ['postgres', checkPostgres],
  ['nats', checkNats],
  ['api', () => checkHttp(config.API_PORT, '/health')],
  ['orchestrator', () => checkHttpInContainer('orchestrator', config.ORCHESTRATOR_PORT, '/health')],
  ['ui', () => checkHttp(config.UI_PORT, '/')],
  ['cabinet remote', () => checkHttp(config.UI_PORT, '/mf/cabinet/remoteEntry.json')],
  ['admin remote', () => checkHttp(config.UI_PORT, '/mf/admin/remoteEntry.json')],
  ['grafana', () => checkHttp(config.GRAFANA_PORT, '/api/health')],
  ['otel-collector', checkCollector],
  ['llm-gateway', () => checkLlmGateway(config.LLM_GATEWAY_PORT)],
  ['identity', () => checkHttp(config.IDENTITY_PORT, '/health')],
  ['mailpit', () => checkHttp(mailpitUiPort, '/')],
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
