import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

// Спека 002, AC-002-20 и AC-002-21: настоящий стек (`npm run up`, LLM_PROFILE=test).
// LLM_GATEWAY_URL, например http://127.0.0.1:3002; без неё тесты пропускаются (как adapter-nats).
// Остальное из окружения: LLM_GATEWAY_TOKEN (из .env), STACK_API_URL — адрес api (по умолчанию порт 3000).
// Запуск: см. README пакета.
const gatewayUrl = process.env['LLM_GATEWAY_URL'];
const apiUrl = process.env['STACK_API_URL'] ?? 'http://127.0.0.1:3000';
const root = fileURLToPath(new URL('../../../', import.meta.url));
const execFileAsync = promisify(execFile);
const json = { 'content-type': 'application/json' };

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} не задан: нужен для стек-тестов llm-gateway`);
  return value;
}

interface RunResult {
  code: number;
  stdout: string;
}

async function run(file: string, args: string[]): Promise<RunResult> {
  try {
    const { stdout } = await execFileAsync(file, args, { cwd: root });
    return { code: 0, stdout };
  } catch (error) {
    const failure = error as { code?: number | string; stdout?: string };
    return {
      code: typeof failure.code === 'number' ? failure.code : -1,
      stdout: failure.stdout ?? '',
    };
  }
}

async function containerId(service: string): Promise<string> {
  const { code, stdout } = await run('docker', ['compose', 'ps', '-q', service]);
  const id = stdout.trim();
  if (code !== 0 || !id) throw new Error(`контейнер ${service} не запущен`);
  return id;
}

async function containerEnv(id: string): Promise<string[]> {
  const { stdout } = await execFileAsync('docker', [
    'inspect',
    '--format',
    '{{json .Config.Env}}',
    id,
  ]);
  return JSON.parse(stdout.trim()) as string[];
}

// Секреты LiteLLM из локального .env.llm: мастер-ключ и ключи провайдеров (имена на _API_KEY). Пустые пропускаются.
function llmSecrets(): Map<string, string> {
  const secrets = new Map<string, string>();
  for (const line of readFileSync(join(root, '.env.llm'), 'utf8').split('\n')) {
    const trimmed = line.trim();
    const at = trimmed.indexOf('=');
    if (trimmed.startsWith('#') || at < 1) continue;
    const name = trimmed.slice(0, at);
    const value = trimmed.slice(at + 1);
    if (value !== '' && (name === 'LITELLM_MASTER_KEY' || name.endsWith('_API_KEY'))) {
      secrets.set(name, value);
    }
  }
  return secrets;
}

interface PlatformEventView {
  type: string;
  source: string;
  data: {
    stream: boolean;
    status: string;
    costMicroUsd: number | null;
    usage: { promptTokens: number; completionTokens: number } | null;
  };
}

async function fetchLlmCalls(swarmId: string, expected: number): Promise<PlatformEventView[]> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const response = await fetch(`${apiUrl}/swarms/${swarmId}/events`);
    const events = (await response.json()) as PlatformEventView[];
    const calls = events.filter((event) => event.type === 'llm.call');
    if (calls.length >= expected || Date.now() > deadline) return calls;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

describe.skipIf(!gatewayUrl)('llm-gateway [stack]', () => {
  it('AC-002-20: вызов без потока и потоком через LiteLLM; два события llm.call в ленте роя', async () => {
    const token = required('LLM_GATEWAY_TOKEN');
    const created = await fetch(`${apiUrl}/swarms`, {
      method: 'POST',
      headers: json,
      body: JSON.stringify({
        task: 'стек-тест AC-002-20',
        agents: [{ name: 'stack', role: 'проверка шлюза LLM' }],
      }),
    });
    expect(created.status).toBe(201);
    const { id: swarmId } = (await created.json()) as { id: string };

    try {
      const headers = {
        ...json,
        authorization: `Bearer ${token}`,
        'x-swag-swarm-id': swarmId,
        'x-swag-agent-id': 'agent-1',
      };
      const messages = [{ role: 'user', content: 'ping' }];

      const plain = await fetch(`${gatewayUrl}/v1/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ model: 'chat-small', messages }),
      });
      expect(plain.status).toBe(200);
      const plainBody = (await plain.json()) as { usage: { prompt_tokens: number } };

      const streamed = await fetch(`${gatewayUrl}/v1/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ model: 'chat-small', messages, stream: true }),
      });
      expect(streamed.status).toBe(200);
      expect(streamed.headers.get('content-type')).toContain('text/event-stream');
      expect(await streamed.text()).toContain('data: [DONE]');

      const calls = await fetchLlmCalls(swarmId, 2);
      expect(calls).toHaveLength(2);
      for (const call of calls) {
        expect(call.source).toBe('llm-gateway');
        expect(call.data.status).toBe('ok');
        expect(call.data.costMicroUsd).toBe(9960);
        expect(call.data.usage).not.toBeNull();
      }
      const plainCall = calls.find((call) => !call.data.stream);
      expect(plainCall?.data.usage?.promptTokens).toBe(plainBody.usage.prompt_tokens);
      expect(calls.find((call) => call.data.stream)).toBeDefined();
    } finally {
      await fetch(`${apiUrl}/swarms/${swarmId}/stop`, { method: 'POST' });
    }
  }, 30_000);

  it('AC-002-21: в env api, orchestrator, ui нет секретов LiteLLM; litellm не разрешается в api', async () => {
    const secrets = llmSecrets();
    for (const service of ['api', 'orchestrator', 'ui']) {
      const env = await containerEnv(await containerId(service));
      const names = env.map((entry) => entry.slice(0, entry.indexOf('=')));
      const values = env.map((entry) => entry.slice(entry.indexOf('=') + 1));
      expect(
        names.filter((name) => secrets.has(name)),
        service,
      ).toEqual([]);
      for (const value of secrets.values()) expect(values, service).not.toContain(value);
    }

    const lookup = await run('docker', [
      'exec',
      await containerId('api'),
      'getent',
      'hosts',
      'litellm',
    ]);
    expect(lookup.code, 'getent должен найти имя и не найти litellm (код 2)').toBe(2);
  }, 60_000);
});
