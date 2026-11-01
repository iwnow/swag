// Запуск UI на хосте без контейнера `ui`: спека 014, 4.9 (`npm run ui:dev`), REQ-014-20.
// Четыре `ng serve` на портах из .env; каркас идёт с прокси `host` (proxy.host.conf.mjs), адреса API и remote — из env.
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import {
  ApiConfig,
  ConfigError,
  IdentityConfig,
  ObservabilityConfig,
  UiConfig,
  loadConfig,
} from '@swag/config';

const SHUTDOWN_TIMEOUT_MS = 5000;
const READY_TIMEOUT_MS = 180_000;
const NG_CLI = fileURLToPath(new URL('../node_modules/@angular/cli/bin/ng.js', import.meta.url));
const isWindows = process.platform === 'win32';

function readConfig() {
  try {
    return loadConfig(
      UiConfig.extend({
        API_PORT: ApiConfig.shape.API_PORT,
        IDENTITY_PORT: IdentityConfig.shape.IDENTITY_PORT,
        GRAFANA_PORT: ObservabilityConfig.shape.GRAFANA_PORT,
      }),
    );
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error(`${error.message}\nСкопируйте .env.example в .env.`);
      process.exit(1);
    }
    throw error;
  }
}

// Занят ли адрес 127.0.0.1:port: пробный listen, сразу освобождается.
function isPortBusy(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once('error', () => resolve(true));
    server.once('listening', () => server.close(() => resolve(false)));
    server.listen(port, '127.0.0.1');
  });
}

function stopProcess(child: ChildProcess): void {
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
  // На Windows kill() снимает только сам процесс, дерево (воркеры ng) — через taskkill /T.
  try {
    if (isWindows)
      spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    else process.kill(-child.pid, 'SIGTERM');
  } catch {
    // Процесс уже завершился (ESRCH): останавливать нечего.
  }
}

function prefixLines(stream: NodeJS.ReadableStream, name: string): void {
  let pending = '';
  stream.setEncoding('utf8');
  stream.on('data', (chunk: string) => {
    const lines = (pending + chunk).split(/\r?\n/);
    pending = lines.pop() ?? '';
    for (const line of lines) process.stdout.write(`[${name}] ${line}\n`);
  });
  stream.on('end', () => {
    if (pending) process.stdout.write(`[${name}] ${pending}\n`);
  });
}

const config = readConfig();

if (await isPortBusy(config.UI_PORT)) {
  console.error(
    `UI_PORT=${config.UI_PORT} на 127.0.0.1 занят. Остановите ui: docker compose stop ui`,
  );
  process.exit(1);
}

const env = {
  ...process.env,
  API_PORT: String(config.API_PORT),
  IDENTITY_PORT: String(config.IDENTITY_PORT),
  GRAFANA_PORT: String(config.GRAFANA_PORT),
  UI_CABINET_PORT: String(config.UI_CABINET_PORT),
  UI_ADMIN_PORT: String(config.UI_ADMIN_PORT),
  UI_SUPERVISOR_PORT: String(config.UI_SUPERVISOR_PORT),
};

const apps = [
  {
    name: 'shell',
    dir: 'apps/ui/shell',
    args: ['--configuration', 'host', '--port', String(config.UI_PORT)],
  },
  { name: 'cabinet', dir: 'apps/ui/cabinet', args: ['--port', String(config.UI_CABINET_PORT)] },
  { name: 'admin', dir: 'apps/ui/admin', args: ['--port', String(config.UI_ADMIN_PORT)] },
  {
    name: 'supervisor',
    dir: 'apps/ui/supervisor',
    args: ['--port', String(config.UI_SUPERVISOR_PORT)],
  },
];

let shuttingDown = false;
const children: { name: string; child: ChildProcess; exited: Promise<void> }[] = [];

async function shutdown(code: number): Promise<never> {
  if (!shuttingDown) {
    shuttingDown = true;
    for (const { child } of children) stopProcess(child);
    await Promise.race([
      Promise.all(children.map(({ exited }) => exited)),
      new Promise((resolve) => setTimeout(resolve, SHUTDOWN_TIMEOUT_MS)),
    ]);
  }
  process.exit(code);
}

// Серверы стартуют по одному: следующий запускается, когда предыдущий напечатал адрес (строка `http://127.0.0.1:`)
// или прошёл таймаут. Одновременный старт четырёх сборок federation здесь наблюдался падениями с 0xC0000005.
function startApp({ name, dir, args }: (typeof apps)[number]): Promise<void> {
  const child = spawn(process.execPath, [NG_CLI, 'serve', ...args], {
    cwd: fileURLToPath(new URL(`../${dir}`, import.meta.url)),
    env,
    detached: !isWindows,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
  children.push({ name, child, exited });
  child.once('error', (error) => {
    console.error(`[${name}] не запустился: ${error.message}, останавливаю остальные`);
    void shutdown(1);
  });
  void exited.then(async () => {
    if (shuttingDown) return;
    const code = child.exitCode ?? 1;
    console.error(`[${name}] завершился с кодом ${code}, останавливаю остальные`);
    await shutdown(code);
  });

  const streams = [child.stdout, child.stderr].filter((stream) => stream !== null);
  for (const stream of streams) prefixLines(stream, name);
  let timer: NodeJS.Timeout | undefined;
  const started = new Promise<void>((resolve) => {
    const onOutput = (chunk: string) => {
      if (!chunk.includes('http://127.0.0.1:')) return;
      clearTimeout(timer);
      for (const stream of streams) stream.off('data', onOutput);
      resolve();
    };
    for (const stream of streams) stream.on('data', onOutput);
  });
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, READY_TIMEOUT_MS);
  });
  return Promise.race([started, exited, timeout]);
}

process.on('SIGINT', () => void shutdown(0));
process.on('SIGTERM', () => void shutdown(0));

for (const app of apps) {
  if (shuttingDown) break;
  await startApp(app);
}
