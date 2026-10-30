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
const EXEC_TIMEOUT_MS = 20_000;
const FETCH_TIMEOUT_MS = 15_000;

// Фейк профиля test: 1000 входных токенов, из них 200 из кэша, 500 выходных.
// Цены test за 1 млн токенов: вход 3,00, кэш 0,30, выход 15,00. В микродолларах:
// 800 · 3,00 + 200 · 0,30 + 500 · 15,00 = 2400 + 60 + 7500 = 9960.
const USAGE = { promptTokens: 1000, cachedPromptTokens: 200, completionTokens: 500 };
const COST_MICRO_USD = 9960;

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} не задан: нужен для стек-тестов llm-gateway`);
  return value;
}

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

async function run(file: string, args: string[]): Promise<RunResult> {
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

async function containerId(service: string): Promise<string> {
  const { code, stdout } = await run('docker', ['compose', 'ps', '-q', service]);
  const id = stdout.trim();
  if (code !== 0 || !id) throw new Error(`контейнер ${service} не запущен`);
  return id;
}

async function containerEnv(id: string): Promise<string[]> {
  const { stdout } = await execFileAsync(
    'docker',
    ['inspect', '--format', '{{json .Config.Env}}', id],
    { timeout: EXEC_TIMEOUT_MS },
  );
  return JSON.parse(stdout.trim()) as string[];
}

interface LlmSecrets {
  // Имена мастер-ключа и ключей провайдеров из .env.llm, пустые значения тоже.
  names: Set<string>;
  // Непустые значения по именам.
  valuesByName: Map<string, string>;
}

function llmSecrets(): LlmSecrets {
  let text: string;
  try {
    text = readFileSync(join(root, '.env.llm'), 'utf8');
  } catch {
    throw new Error('нужен .env.llm (его читает compose)');
  }
  const names = new Set<string>();
  const valuesByName = new Map<string, string>();
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    const at = trimmed.indexOf('=');
    if (trimmed.startsWith('#') || at < 1) continue;
    const name = trimmed.slice(0, at);
    if (name !== 'LITELLM_MASTER_KEY' && !name.endsWith('_API_KEY')) continue;
    names.add(name);
    const value = trimmed.slice(at + 1);
    if (value !== '') valuesByName.set(name, value);
  }
  return { names, valuesByName };
}

interface PlatformEventView {
  type: string;
  source: string;
  data: {
    stream: boolean;
    status: string;
    costMicroUsd: number | null;
    usage: { promptTokens: number; cachedPromptTokens: number; completionTokens: number } | null;
  };
}

async function fetchLlmCalls(swarmId: string, expected: number): Promise<PlatformEventView[]> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const response = await fetch(`${apiUrl}/swarms/${swarmId}/events`, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    expect(response.status).toBe(200);
    const events = (await response.json()) as PlatformEventView[];
    const calls = events.filter((event) => event.type === 'llm.call');
    if (calls.length >= expected || Date.now() > deadline) return calls;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

// Кадры SSE без [DONE]: строки `data: <payload>`.
function sseFrames(text: string): string[] {
  return text
    .split('\n')
    .filter((line) => line.startsWith('data: '))
    .map((line) => line.slice('data: '.length));
}

interface ChatChunk {
  choices?: { delta?: { content?: string } }[];
  usage?: unknown;
}

interface ChatResponse {
  choices: { message: { content: string } }[];
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    prompt_tokens_details: { cached_tokens: number };
  };
}

describe.skipIf(!gatewayUrl)('llm-gateway [stack]', () => {
  it('AC-002-20: вызов без потока и потоком через LiteLLM; два события llm.call в ленте роя', async () => {
    const token = required('LLM_GATEWAY_TOKEN');
    const created = await fetch(`${apiUrl}/swarms`, {
      method: 'POST',
      headers: json,
      body: JSON.stringify({
        task: 'стек-тест AC-002-20',
        budgetMicroUsd: 5_000_000,
        agents: [{ name: 'stack', role: 'проверка шлюза LLM' }],
      }),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    expect(created.status).toBe(201);
    const { id: swarmId } = (await created.json()) as { id: string };

    try {
      // Спека 004, 4.2: рой регистрируется в gateway до вызовов; без регистрации вызов дал бы 403 caller_not_registered.
      const registered = await fetch(`${gatewayUrl}/internal/swarms`, {
        method: 'POST',
        headers: { ...json, authorization: `Bearer ${token}` },
        body: JSON.stringify({
          swarmId,
          budgetMicroUsd: 5_000_000,
          expiresAt: null,
          agents: [{ agentId: 'agent-1', model: 'chat-small', budgetMicroUsd: null }],
        }),
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      expect(registered.status).toBe(204);

      const since = new Date().toISOString();
      const headers = {
        ...json,
        authorization: `Bearer ${token}`,
        'x-swag-swarm-id': swarmId,
        'x-swag-agent-id': 'agent-1',
      };
      const messages = [{ role: 'user', content: 'ping' }];
      const signal = () => AbortSignal.timeout(FETCH_TIMEOUT_MS);

      const plain = await fetch(`${gatewayUrl}/v1/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ model: 'chat-small', max_tokens: 256, messages }),
        signal: signal(),
      });
      expect(plain.status).toBe(200);
      const plainBody = (await plain.json()) as ChatResponse;
      expect(plainBody.choices[0]?.message.content).toBe('fake reply');
      expect(plainBody.usage.prompt_tokens).toBe(USAGE.promptTokens);
      expect(plainBody.usage.completion_tokens).toBe(USAGE.completionTokens);
      expect(plainBody.usage.prompt_tokens_details.cached_tokens).toBe(USAGE.cachedPromptTokens);

      const streamed = await fetch(`${gatewayUrl}/v1/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ model: 'chat-small', max_tokens: 256, messages, stream: true }),
        signal: signal(),
      });
      expect(streamed.status).toBe(200);
      expect(streamed.headers.get('content-type')).toContain('text/event-stream');
      const frames = sseFrames(await streamed.text());
      expect(frames.at(-1)).toBe('[DONE]');
      const chunks = frames
        .filter((frame) => frame !== '[DONE]')
        .map((frame) => JSON.parse(frame) as ChatChunk);
      const content = chunks.map((chunk) => chunk.choices?.[0]?.delta?.content ?? '').join('');
      expect(content).toBe('fake reply');
      expect(chunks.some((chunk) => chunk.usage !== undefined)).toBe(true);

      const calls = await fetchLlmCalls(swarmId, 2);
      expect(calls).toHaveLength(2);
      for (const call of calls) {
        expect(call.source).toBe('llm-gateway');
        expect(call.data.status).toBe('ok');
        expect(call.data.costMicroUsd).toBe(COST_MICRO_USD);
        expect(call.data.usage).toMatchObject(USAGE);
      }
      expect(calls.map((call) => call.data.stream).sort()).toEqual([false, true]);

      // Запрос дошёл до настоящего LiteLLM: его журнал содержит вызов после начала теста.
      const litellm = await run('docker', ['logs', '--since', since, await containerId('litellm')]);
      expect(litellm.stdout + litellm.stderr).toContain('/chat/completions');
    } finally {
      await fetch(`${gatewayUrl}/internal/swarms/${swarmId}/close`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      }).catch(() => undefined);
      await fetch(`${apiUrl}/swarms/${swarmId}/stop`, {
        method: 'POST',
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      }).catch(() => undefined);
    }
  }, 60_000);

  it('AC-002-21: в env api, orchestrator, ui нет секретов LiteLLM; litellm не разрешается в api', async () => {
    const secrets = llmSecrets();
    for (const service of ['api', 'orchestrator', 'ui']) {
      const env = await containerEnv(await containerId(service));
      const names = env.map((entry) => entry.slice(0, entry.indexOf('=')));
      const values = env.map((entry) => entry.slice(entry.indexOf('=') + 1));
      const forbidden = names.filter(
        (name) =>
          name === 'LITELLM_MASTER_KEY' || name.endsWith('_API_KEY') || secrets.names.has(name),
      );
      expect(forbidden, service).toEqual([]);
      // Печатаются только имена: значение секрета в сообщении об ошибке не появляется.
      const leaked = [...secrets.valuesByName]
        .filter(([, secret]) => values.some((value) => value.includes(secret)))
        .map(([name]) => name);
      expect(leaked, service).toEqual([]);
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
