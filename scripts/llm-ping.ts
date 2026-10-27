// Один вызов через LLM Gateway с хоста: спека 002, 4.13, REQ-002-17.
// Запуск: `npm run llm:ping [model] [-- --stream]`.
import { randomUUID } from 'node:crypto';
import { ConfigError, LlmGatewayConfig, loadConfig } from '@swag/config';
import { AGENT_ID_HEADER, SWARM_ID_HEADER } from '@swag/contracts';

const DEFAULT_MODEL = 'chat-small';
const PROMPT = 'Ответь одним словом: пинг';

interface ChatCompletion {
  choices?: { message?: { content?: string | null } }[];
  usage?: unknown;
}

interface ChatCompletionChunk {
  choices?: { delta?: { content?: string | null } }[];
  usage?: unknown;
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

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const stream = args.includes('--stream');
  const model = args.find((arg) => !arg.startsWith('--')) ?? DEFAULT_MODEL;
  const config = readConfig();

  const started = performance.now();
  let response: Response;
  try {
    response = await fetch(`http://127.0.0.1:${config.LLM_GATEWAY_PORT}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${config.LLM_GATEWAY_TOKEN}`,
        'content-type': 'application/json',
        [SWARM_ID_HEADER]: randomUUID(),
        [AGENT_ID_HEADER]: 'agent-1',
      },
      body: JSON.stringify({
        model,
        stream,
        messages: [{ role: 'user', content: PROMPT }],
      }),
    });
  } catch (error) {
    fail(`Шлюз недоступен: ${error instanceof Error ? error.message : String(error)}`);
  }

  if (response.status !== 200) {
    fail(`HTTP ${response.status}\n${await response.text()}`);
  }

  console.log(`модель: ${model}`);
  let usage: unknown;
  if (stream) {
    process.stdout.write('ответ: ');
    if (!response.body) fail('Пустое тело потока');
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

main().catch((error: unknown) => fail(error instanceof Error ? error.message : String(error)));
