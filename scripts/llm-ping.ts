// Один вызов через LLM Gateway с хоста: спека 002, 4.13, REQ-002-17; регистрация и закрытие роя — спека 004, 4.13.
// Запуск: `npm run llm:ping [model] [-- --stream]`.
import { randomUUID } from 'node:crypto';
import { ConfigError, LlmGatewayConfig, loadConfig } from '@swag/config';
import { AGENT_ID_HEADER, SWARM_ID_HEADER, type LlmSwarmRegistration } from '@swag/contracts';

const DEFAULT_MODEL = 'chat-small';
const PROMPT = 'Ответь одним словом: пинг';
const AGENT_ID = 'agent-1';
const SWARM_BUDGET_MICRO_USD = 1_000_000;
const SWARM_TTL_MS = 5 * 60 * 1000;
const MAX_TOKENS = 256;

interface ChatCompletion {
  choices?: { message?: { content?: string | null } }[];
  usage?: unknown;
}

interface ChatCompletionChunk {
  choices?: { delta?: { content?: string | null } }[];
  usage?: unknown;
}

interface Gateway {
  baseUrl: string;
  token: string;
}

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

function readConfig() {
  try {
    return loadConfig(LlmGatewayConfig.pick({ LLM_GATEWAY_PORT: true, LLM_GATEWAY_TOKEN: true }));
  } catch (error) {
    if (error instanceof ConfigError) fail(`${error.message}\nСкопируйте .env.example в .env.`);
    throw error;
  }
}

async function gatewayRequest(
  gateway: Gateway,
  path: string,
  init: { method: string; headers?: Record<string, string>; body?: string },
): Promise<Response> {
  try {
    return await fetch(`${gateway.baseUrl}${path}`, {
      ...init,
      headers: { ...init.headers, authorization: `Bearer ${gateway.token}` },
    });
  } catch (error) {
    throw new Error(`Шлюз недоступен: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function httpError(response: Response): Promise<string> {
  return `HTTP ${response.status}\n${await response.text()}`;
}

/** Разбор SSE из шлюза: кадры `data: <json>` разделены пустой строкой, `[DONE]` пропускается. */
async function readStream(body: ReadableStream<Uint8Array>): Promise<unknown> {
  const decoder = new TextDecoder();
  let buffer = '';
  let usage: unknown;

  const handleEvent = (event: string) => {
    for (const line of event.split('\n')) {
      if (!line.startsWith('data: ')) continue;
      const payload = line.slice('data: '.length);
      if (payload === '[DONE]') continue;
      const chunk = JSON.parse(payload) as ChatCompletionChunk;
      const delta = chunk.choices?.[0]?.delta?.content;
      if (delta) process.stdout.write(delta);
      if (chunk.usage !== undefined) usage = chunk.usage;
    }
  };

  for await (const bytes of body) {
    buffer += decoder.decode(bytes, { stream: true });
    let end = buffer.indexOf('\n\n');
    while (end >= 0) {
      handleEvent(buffer.slice(0, end));
      buffer = buffer.slice(end + 2);
      end = buffer.indexOf('\n\n');
    }
  }
  buffer += decoder.decode();
  if (buffer.trim()) handleEvent(buffer);
  return usage;
}

async function registerSwarm(gateway: Gateway, swarmId: string, model: string): Promise<void> {
  const registration: LlmSwarmRegistration = {
    swarmId,
    budgetMicroUsd: SWARM_BUDGET_MICRO_USD,
    expiresAt: new Date(Date.now() + SWARM_TTL_MS).toISOString(),
    agents: [{ agentId: AGENT_ID, model, budgetMicroUsd: null }],
  };
  const response = await gatewayRequest(gateway, '/internal/swarms', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(registration),
  });
  if (response.status !== 204) throw new Error(`регистрация роя: ${await httpError(response)}`);
}

async function closeSwarm(gateway: Gateway, swarmId: string): Promise<void> {
  const response = await gatewayRequest(gateway, `/internal/swarms/${swarmId}/close`, {
    method: 'POST',
  });
  if (response.status !== 200) throw new Error(`закрытие роя: ${await httpError(response)}`);
}

async function callModel(
  gateway: Gateway,
  swarmId: string,
  model: string,
  stream: boolean,
): Promise<void> {
  const started = performance.now();
  const response = await gatewayRequest(gateway, '/v1/chat/completions', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      [SWARM_ID_HEADER]: swarmId,
      [AGENT_ID_HEADER]: AGENT_ID,
    },
    body: JSON.stringify({
      model,
      stream,
      max_tokens: MAX_TOKENS,
      messages: [{ role: 'user', content: PROMPT }],
    }),
  });
  if (response.status !== 200) throw new Error(await httpError(response));

  console.log(`модель: ${model}`);
  let usage: unknown;
  if (stream) {
    process.stdout.write('ответ: ');
    if (!response.body) throw new Error('Пустое тело потока');
    usage = await readStream(response.body);
    process.stdout.write('\n');
  } else {
    const body = (await response.json()) as ChatCompletion;
    console.log(`ответ: ${body.choices?.[0]?.message?.content ?? ''}`);
    usage = body.usage;
  }
  const latencyMs = Math.round(performance.now() - started);
  console.log(`usage: ${JSON.stringify(usage)}`);
  console.log(`задержка: ${latencyMs} мс`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const stream = args.includes('--stream');
  const model = args.find((arg) => !arg.startsWith('--')) ?? DEFAULT_MODEL;
  const config = readConfig();
  const gateway: Gateway = {
    baseUrl: `http://127.0.0.1:${config.LLM_GATEWAY_PORT}`,
    token: config.LLM_GATEWAY_TOKEN,
  };
  const swarmId = randomUUID();

  await registerSwarm(gateway, swarmId, model);
  let callFailed: { error: unknown } | undefined;
  try {
    await callModel(gateway, swarmId, model, stream);
  } catch (error) {
    callFailed = { error };
  }
  try {
    await closeSwarm(gateway, swarmId);
  } catch (closeError) {
    if (!callFailed) throw closeError;
    console.error(closeError instanceof Error ? closeError.message : String(closeError));
  }
  if (callFailed) throw callFailed.error;
}

main().catch((error: unknown) => fail(error instanceof Error ? error.message : String(error)));
