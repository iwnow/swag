// Спека 002, 4.12: фейковый провайдер в формате OpenAI. Только node:http, без зависимостей.
// Потоковая часть (stream: true, __slow_chunks__, __cut__, __hang__) — T-8; сейчас stream: true отвечает 501.
import {
  createServer,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';

export interface FakeRequest {
  path: string;
  headers: Record<string, string>;
  body: unknown;
  closedByClient: boolean;
}

export interface FakeProvider {
  url: string;
  close(): Promise<void>;
  requests: FakeRequest[];
}

const DEFAULT_MODELS = ['chat-small', 'chat-large'];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

function parseBody(raw: string): unknown {
  if (raw === '') return undefined;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return raw;
  }
}

function lastMessageText(body: unknown): string {
  if (!isRecord(body) || !Array.isArray(body.messages)) return '';
  const content = (body.messages.at(-1) as { content?: unknown } | undefined)?.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part: unknown) => (isRecord(part) && typeof part.text === 'string' ? part.text : ''))
    .join('');
}

// undefined — в запросе нет tools; иначе имя первого инструмента.
function firstToolName(body: unknown): string | undefined {
  if (!isRecord(body) || !Array.isArray(body.tools) || body.tools.length === 0) return undefined;
  const tool: unknown = body.tools[0];
  const fn = isRecord(tool) ? tool.function : undefined;
  return isRecord(fn) && typeof fn.name === 'string' ? fn.name : '';
}

function flattenHeaders(raw: IncomingHttpHeaders): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(raw)) {
    if (value !== undefined) headers[name] = Array.isArray(value) ? value.join(', ') : value;
  }
  return headers;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

function usage(withCost: boolean) {
  return {
    prompt_tokens: 1000,
    completion_tokens: 500,
    total_tokens: 1500,
    prompt_tokens_details: { cached_tokens: 200 },
    ...(withCost ? { cost: 0.0085 } : {}),
  };
}

async function readRaw(req: AsyncIterable<unknown>): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  models: string[],
  requests: FakeRequest[],
): Promise<void> {
  const path = new URL(req.url ?? '/', 'http://fake').pathname;
  const body = parseBody(await readRaw(req));
  const headers = flattenHeaders(req.headers);
  requests.push({ path, headers, body, closedByClient: false });

  if (req.method === 'GET' && path === '/v1/models') {
    sendJson(res, 200, { object: 'list', data: models.map((id) => ({ id })) });
    return;
  }
  if (req.method !== 'POST' || path !== '/v1/chat/completions') {
    sendJson(res, 404, { error: { message: 'not found' } });
    return;
  }

  const text = lastMessageText(body);
  if (text.includes('__fail_500__')) return sendJson(res, 500, { error: { message: 'boom' } });
  if (text.includes('__fail_429__')) return sendJson(res, 429, { error: { message: 'slow down' } });
  if (text.includes('__fail_400__')) {
    const auth = headers.authorization ?? '';
    return sendJson(res, 400, { error: { message: `bad request, auth was: ${auth}` } });
  }
  if (isRecord(body) && body.stream === true) {
    return sendJson(res, 501, { error: { message: 'stream is not implemented (T-8)' } });
  }

  const toolName = firstToolName(body);
  const message =
    toolName === undefined
      ? { role: 'assistant', content: 'fake reply' }
      : {
          role: 'assistant',
          content: null,
          tool_calls: [
            { id: 'call_fake_1', type: 'function', function: { name: toolName, arguments: '{}' } },
          ],
        };
  sendJson(res, 200, {
    id: 'chatcmpl-fake',
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: isRecord(body) ? body.model : undefined,
    choices: [{ index: 0, message, finish_reason: toolName === undefined ? 'stop' : 'tool_calls' }],
    ...(text.includes('__no_usage__') ? {} : { usage: usage(!text.includes('__no_cost__')) }),
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
    server.closeAllConnections();
  });
}

export function startFakeProvider(opts: {
  port: number;
  models?: string[];
}): Promise<FakeProvider> {
  const models = opts.models ?? DEFAULT_MODELS;
  const requests: FakeRequest[] = [];
  const server = createServer((req, res) => {
    handle(req, res, models, requests).catch((error: unknown) =>
      sendJson(res, 500, { error: { message: String(error) } }),
    );
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port, () => {
      const address = server.address();
      if (!isRecord(address)) {
        reject(new Error('fake provider: нет адреса сервера'));
        return;
      }
      resolve({
        url: `http://127.0.0.1:${String(address.port)}`,
        requests,
        close: () => closeServer(server),
      });
    });
  });
}

if (import.meta.main) {
  const port = Number(process.env.FAKE_PROVIDER_PORT);
  if (!Number.isInteger(port) || port <= 0) {
    console.error('FAKE_PROVIDER_PORT не задан или не целое положительное число');
    process.exit(1);
  }
  startFakeProvider({ port })
    .then((fake) => console.log(`llm-fake слушает порт ${String(port)} (${fake.url})`))
    .catch((error: unknown) => {
      console.error(error);
      process.exit(1);
    });
}
