import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

// Общие хелперы стек-тестов llm-gateway (спека 002, 004): команды из корня репозитория и адрес api.
// Тесты пропускаются без LLM_GATEWAY_URL — гейт остаётся в файлах тестов.
export const root = fileURLToPath(new URL('../../../', import.meta.url));
export const apiUrl = process.env['STACK_API_URL'] ?? 'http://127.0.0.1:3000';
export const EXEC_TIMEOUT_MS = 20_000;
export const FETCH_TIMEOUT_MS = 15_000;

const execFileAsync = promisify(execFile);

export function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} не задан: нужен для стек-тестов llm-gateway`);
  return value;
}

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export async function run(file: string, args: string[]): Promise<RunResult> {
  try {
    const { stdout, stderr } = await execFileAsync(file, args, {
      cwd: root,
      timeout: EXEC_TIMEOUT_MS,
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failure = error as { code?: number | string; stdout?: string; stderr?: string };
    return {
      code: typeof failure.code === 'number' ? failure.code : -1,
      stdout: failure.stdout ?? '',
      stderr: failure.stderr ?? '',
    };
  }
}

export async function containerId(service: string): Promise<string> {
  const { code, stdout } = await run('docker', ['compose', 'ps', '-q', service]);
  const id = stdout.trim();
  if (code !== 0 || !id) throw new Error(`контейнер ${service} не запущен`);
  return id;
}
