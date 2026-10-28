// Спека 002, 4.12: фейковый провайдер в формате OpenAI. Только node:http, без зависимостей.
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
  // Только POST /v1/chat/completions: GET /v1/models и неизвестные пути не записываются.
  requests: FakeRequest[];
}

const DEFAULT_MODELS = ['chat-small', 'chat-large'];
const SLOW_CHUNK_DELAY_MS = 500;

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

// Спека 022, 4.7: роль последнего сообщения.
function lastMessageRole(body: unknown): unknown {
  if (!isRecord(body) || !Array.isArray(body.messages)) return undefined;
  return (body.messages.at(-1) as { role?: unknown } | undefined)?.role;
}

// Спека 022, 4.7: JSON после маркера `__tool_calls__`; невалидный JSON или не [{ name, arguments }] — undefined.
function markedToolCalls(
  text: string,
): { name: string; arguments: Record<string, unknown> }[] | undefined {
  const marker = '__tool_calls__';
  const index = text.indexOf(marker);
  if (index === -1) return undefined;
  try {
    const calls: unknown = JSON.parse(text.slice(index + marker.length));
    if (!Array.isArray(calls)) return undefined;
    const valid = calls.every(
      (call) => isRecord(call) && typeof call.name === 'string' && isRecord(call.arguments),
    );
    return valid ? (calls as { name: string; arguments: Record<string, unknown> }[]) : undefined;
  } catch {
    return undefined;
  }
}

// Спека 022, 4.7: правила проверяются раньше таблицы 4.12 (без потока). undefined — правило не сработало.
function scriptedChoice(
  body: unknown,
  text: string,
): { message: object; finishReason: string } | undefined {
  if (lastMessageRole(body) === 'tool') {
    return { message: { role: 'assistant', content: 'fake reply' }, finishReason: 'stop' };
  }
  const calls = markedToolCalls(text);
  if (calls === undefined) return undefined;
  const tool_calls = calls.map((call, index) => ({
    id: `call_${String(index)}`,
    type: 'function',
    function: { name: call.name, arguments: JSON.stringify(call.arguments) },
  }));
  return {
    message: { role: 'assistant', content: null, tool_calls },
    finishReason: 'tool_calls',
  };
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

// Пауза между фрагментами читается на каждом запросе: тесты меняют env на время теста.
function chunkDelayMs(): number {
  const value = Number(process.env.FAKE_CHUNK_DELAY_MS ?? 0);
  return Number.isFinite(value) && value >= 0 ? value : 0;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const writeFrame = (res: ServerResponse, data: string) =>
  new Promise<void>((resolve) => res.write(`data: ${data}\n\n`, () => resolve()));

// closedByClient — сокет закрыт до конца ответа, кроме собственного обрыва `__cut__`.
// Закрытие через closeServer() (closeAllConnections) тоже попадает сюда: это закрытие до конца ответа.
// Возвращает markOwnCut: `__cut__` вызывает её перед своим обрывом.
function watchClientClose(res: ServerResponse, record: FakeRequest): () => void {
  let ownCut = false;
  res.on('close', () => {
    if (!res.writableFinished && !ownCut) record.closedByClient = true;
  });
  return () => {
    ownCut = true;
  };
}

function streamEvents(body: unknown, text: string): unknown[] {
  const base = {
    id: 'chatcmpl-fake',
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model: isRecord(body) ? body.model : undefined,
  };
  const events: unknown[] = [
    {
      ...base,
      choices: [{ index: 0, delta: { role: 'assistant', content: 'fake' }, finish_reason: null }],
    },
    { ...base, choices: [{ index: 0, delta: { content: ' reply' }, finish_reason: 'stop' }] },
  ];
  const includeUsage =
    isRecord(body) && isRecord(body.stream_options) && body.stream_options.include_usage === true;
  if (includeUsage && !text.includes('__no_usage__')) {
    events.push({ ...base, choices: [], usage: usage(!text.includes('__no_cost__')) });
  }
  return events;
}

// Поток SSE: пауза между всеми кадрами, включая usage и [DONE]. __cut__ — первый кадр, затем обрыв сокета.
async function streamResponse(
  req: IncomingMessage,
  res: ServerResponse,
  record: FakeRequest,
  body: unknown,
  text: string,
): Promise<void> {
  const markOwnCut = watchClientClose(res, record);
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });

  const frames = [...streamEvents(body, text).map((event) => JSON.stringify(event)), '[DONE]'];
  const delay = text.includes('__slow_chunks__') ? SLOW_CHUNK_DELAY_MS : chunkDelayMs();
  const cut = text.includes('__cut__');
  for (const [index, data] of frames.entries()) {
    if (index > 0) await sleep(delay);
    if (res.destroyed) return;
    await writeFrame(res, data);
    if (cut) {
      markOwnCut();
      req.socket.destroy();
      return;
    }
  }
  res.end();
}

async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  models: string[],
  requests: FakeRequest[],
): Promise<void> {
  const path = new URL(req.url ?? '/', 'http://fake').pathname;
  const raw = await readRaw(req);

  if (req.method === 'GET' && path === '/v1/models') {
    sendJson(res, 200, { object: 'list', data: models.map((id) => ({ id })) });
    return;
  }
  if (req.method !== 'POST' || path !== '/v1/chat/completions') {
    sendJson(res, 404, { error: { message: 'not found' } });
    return;
  }

  const body = parseBody(raw);
  const headers = flattenHeaders(req.headers);
  const record: FakeRequest = { path, headers, body, closedByClient: false };
  requests.push(record);

  const text = lastMessageText(body);
  const stream = isRecord(body) && body.stream === true;
  const scripted = stream ? undefined : scriptedChoice(body, text);
  if (scripted) {
    return sendJson(res, 200, completion(body, text, scripted.message, scripted.finishReason));
  }
  if (text.includes('__fail_500__')) return sendJson(res, 500, { error: { message: 'boom' } });
  if (text.includes('__fail_429__')) return sendJson(res, 429, { error: { message: 'slow down' } });
  if (text.includes('__fail_400__')) {
    const auth = headers.authorization ?? '';
    return sendJson(res, 400, { error: { message: `bad request, auth was: ${auth}` } });
  }
  if (text.includes('__hang__')) {
    // Ответа нет никогда: соединение закроет клиент (closedByClient) или closeServer().
    watchClientClose(res, record);
    return;
  }
  if (stream) {
    return streamResponse(req, res, record, body, text);
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
  sendJson(
    res,
    200,
    completion(body, text, message, toolName === undefined ? 'stop' : 'tool_calls'),
  );
}

function completion(body: unknown, text: string, message: object, finishReason: string) {
  return {
    id: 'chatcmpl-fake',
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: isRecord(body) ? body.model : undefined,
    choices: [{ index: 0, message, finish_reason: finishReason }],
    ...(text.includes('__no_usage__') ? {} : { usage: usage(!text.includes('__no_cost__')) }),
  };
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
  return listenFakeProvider(opts, '127.0.0.1');
}

// host: тесты — 127.0.0.1; запуск скриптом — 0.0.0.0, чтобы litellm достучался по имени сервиса (D-44).
function listenFakeProvider(
  opts: { port: number; models?: string[] },
  host: string,
): Promise<FakeProvider> {
  const models = opts.models ?? DEFAULT_MODELS;
  const requests: FakeRequest[] = [];
  const server = createServer((req, res) => {
    handle(req, res, models, requests).catch((error: unknown) =>
      sendJson(res, 500, { error: { message: String(error) } }),
    );
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port, host, () => {
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
  listenFakeProvider({ port }, '0.0.0.0')
    .then((fake) => console.log(`llm-fake слушает порт ${String(port)} (${fake.url})`))
    .catch((error: unknown) => {
      console.error(error);
      process.exit(1);
    });
}
