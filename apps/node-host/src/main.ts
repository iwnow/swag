import { fork, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { HostFrame, SandboxFrame } from '@swag/contracts';

// Спека 026, 4.8 (REQ-026-5, REQ-026-12). Родитель: единственный, кто пишет в stdout контейнера.
type InvokeFrame = Extract<HostFrame, { t: 'invoke' }>;
type ResultFrame = Extract<SandboxFrame, { t: 'result' }>;

const CHILD_PATH = fileURLToPath(new URL('./child.ts', import.meta.url));

function write(frame: SandboxFrame): void {
  process.stdout.write(`${JSON.stringify(frame)}\n`);
}

function parseLine(line: string): unknown {
  try {
    return JSON.parse(line) as unknown;
  } catch {
    return undefined;
  }
}

const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
let child: ChildProcess | undefined;
let finished = false;

function finish(frame: ResultFrame): void {
  if (finished) return;
  finished = true;
  write(frame);
  input.close();
  process.stdin.destroy();
  process.exitCode = 0;
}

function startChild(invoke: InvokeFrame): ChildProcess {
  const proc = fork(CHILD_PATH, { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  let result: ResultFrame | undefined;

  proc.send({
    t: 'invoke',
    package: invoke.package,
    definition: invoke.definition,
    call: invoke.call,
    settings: invoke.settings,
    secrets: invoke.secrets,
    egressProxy: invoke.egressProxy,
    deadlineMs: invoke.deadline,
  });

  // Строки stdout и stderr читаются до закрытия потоков: result пишется только после события close,
  // поэтому строки, пришедшие до result, уходят раньше него.
  if (proc.stdout) {
    createInterface({ input: proc.stdout }).on('line', (msg) =>
      write({ t: 'log', level: 'info', msg }),
    );
  }
  if (proc.stderr) {
    createInterface({ input: proc.stderr }).on('line', (msg) =>
      write({ t: 'log', level: 'warn', msg }),
    );
  }

  proc.on('message', (message) => {
    const parsed = SandboxFrame.safeParse(message);
    if (!parsed.success) {
      write({ t: 'log', level: 'warn', msg: 'node-host: invalid child message' });
      return;
    }
    if (parsed.data.t === 'result') result = parsed.data;
    else write(parsed.data);
  });

  proc.on('error', (error) => {
    finish({
      t: 'result',
      ok: false,
      code: 'node_failed',
      message: `child failed: ${error.message}`,
    });
    if (proc.exitCode === null && proc.signalCode === null) proc.kill();
  });

  proc.on('close', (code, signal) => {
    finish(
      result ?? {
        t: 'result',
        ok: false,
        code: 'node_failed',
        message: `child exited ${String(signal ?? code)}`,
      },
    );
  });

  return proc;
}

let refused = false;

function refuse(reason: string): void {
  if (refused) return;
  refused = true;
  process.stderr.write(`node-host: ${reason}\n`);
  process.exitCode = 1;
  input.close();
  process.stdin.destroy();
}

input.on('line', (line) => {
  const parsed = HostFrame.safeParse(parseLine(line));
  if (!child) {
    if (!parsed.success || parsed.data.t !== 'invoke') {
      refuse('первый кадр должен быть корректным invoke');
      return;
    }
    child = startChild(parsed.data);
    return;
  }
  if (!parsed.success) {
    process.stderr.write('node-host: некорректный кадр, пропущен\n');
    return;
  }
  const frame = parsed.data;
  if (frame.t === 'invoke') {
    process.stderr.write('node-host: повторный invoke пропущен\n');
    return;
  }
  if (child.connected) child.send(frame);
});

input.on('close', () => {
  if (!child) refuse('stdin закрыт до invoke');
});
