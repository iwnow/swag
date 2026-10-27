import { context, propagation } from '@opentelemetry/api';
import {
  UpstreamStreamError,
  type ChatRequest,
  type LlmUpstream,
  type UpstreamFailure,
  type UpstreamModels,
  type UpstreamResponse,
  type UpstreamStream,
} from '@swag/llm-gateway-core';

// Спека 002, 4.5: адаптер LiteLLM. Спан litellm.chat — T-12.

export interface LiteLlmOptions {
  baseUrl: string; // LITELLM_URL
  masterKey: string; // LITELLM_MASTER_KEY → Authorization: Bearer
  idleTimeoutMs: number; // LLM_GATEWAY_UPSTREAM_TIMEOUT_MS
  secrets: string[]; // значения, которые заменяются на *** в message
  fetch?: typeof fetch; // для тестов; по умолчанию глобальный
}

const MESSAGE_LIMIT = 1000;
const CHAT_PATH = '/v1/chat/completions';
const DONE = '[DONE]';

// Пустые строки игнорируются: иначе replaceAll('', '***') вставит маркер между всеми символами.
export function redact(text: string, secrets: string[]): string {
  return secrets.reduce(
    (result, secret) => (secret === '' ? result : result.replaceAll(secret, '***')),
    text,
  );
}

const errorMessage = (body: unknown): string | null => {
  if (typeof body !== 'object' || body === null || !('error' in body)) return null;
  const error = body.error;
  if (typeof error !== 'object' || error === null || !('message' in error)) return null;
  return typeof error.message === 'string' ? error.message : null;
};

// undefined — тело не читается как JSON (у JSON нет значения undefined).
function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function httpFailure(status: number, text: string, secrets: string[]): UpstreamFailure {
  const message = errorMessage(parseJson(text)) ?? `HTTP ${status}`;
  return { kind: 'http', status, message: redact(message.slice(0, MESSAGE_LIMIT), secrets) };
}

// Причина срабатывания таймера: по ней отличаем таймаут от внешнего abort.
const TIMEOUT_REASON = Symbol('idle-timeout');

// Спека 002, 4.5: таймер простоя взводится до запроса и перезапускается на каждом куске тела.
// Сигнал запроса объединяет его с внешним signal; AbortSignal.any отдаёт reason первого сработавшего источника.
function idleGuard(outer: AbortSignal, idleTimeoutMs: number) {
  const own = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const arm = () => {
    clearTimeout(timer);
    timer = setTimeout(() => own.abort(TIMEOUT_REASON), idleTimeoutMs);
  };
  arm();
  return {
    signal: AbortSignal.any([outer, own.signal]),
    arm,
    stop: () => clearTimeout(timer),
  };
}

type IdleGuard = ReturnType<typeof idleGuard>;

// Сбой запроса или чтения тела без потока: таймер → timeout, иначе network (и внешний abort тоже).
const transportFailure = (idle: IdleGuard): UpstreamFailure =>
  idle.signal.reason === TIMEOUT_REASON ? { kind: 'timeout' } : { kind: 'network' };

// Куски тела текстом; arm — на каждом куске. Раннее закрытие потребителем отменяет чтение и закрывает соединение.
async function* textChunks(res: Response, arm: () => void): AsyncGenerator<string> {
  if (!res.body) return;
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  try {
    for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) {
      arm();
      yield decoder.decode(chunk.value, { stream: true });
    }
    yield decoder.decode();
  } finally {
    reader.cancel().catch(() => {});
  }
}

async function readText(res: Response, arm: () => void): Promise<string> {
  let text = '';
  for await (const part of textChunks(res, arm)) text += part;
  return text;
}

// Пропагатор глобальный: его ставит startTelemetry из adapter-telemetry; без SDK заголовка не будет.
function authHeaders(options: LiteLlmOptions): Record<string, string> {
  const headers: Record<string, string> = { authorization: `Bearer ${options.masterKey}` };
  propagation.inject(context.active(), headers);
  return headers;
}

type Init = { method: 'GET' | 'POST'; headers: Record<string, string>; body?: string };

const postJson = (options: LiteLlmOptions, body: ChatRequest): Init => ({
  method: 'POST',
  headers: { 'content-type': 'application/json', ...authHeaders(options) },
  body: JSON.stringify(body),
});

type Opened =
  { ok: true; res: Response; idle: IdleGuard } | { ok: false; failure: UpstreamFailure };

// Заголовки ответа. Отказ до заголовков — failure. При успехе таймер остаётся взведённым: его снимает читающий.
async function open(
  options: LiteLlmOptions,
  path: string,
  init: Init,
  signal: AbortSignal,
): Promise<Opened> {
  const idle = idleGuard(signal, options.idleTimeoutMs);
  try {
    const res = await (options.fetch ?? fetch)(`${options.baseUrl}${path}`, {
      ...init,
      signal: idle.signal,
    });
    return { ok: true, res, idle };
  } catch {
    idle.stop();
    return { ok: false, failure: transportFailure(idle) };
  }
}

// Тело целиком; таймер снимается по окончании чтения.
async function readWhole(opened: {
  res: Response;
  idle: IdleGuard;
}): Promise<{ ok: true; text: string } | { ok: false; failure: UpstreamFailure }> {
  try {
    return { ok: true, text: await readText(opened.res, opened.idle.arm) };
  } catch {
    return { ok: false, failure: transportFailure(opened.idle) };
  } finally {
    opened.idle.stop();
  }
}

// Один вызов апстрима без потока (complete и listModels): отказы сети, таймаут, статус, потом разбор JSON.
async function callUpstream(
  options: LiteLlmOptions,
  path: string,
  init: Init,
  signal: AbortSignal,
): Promise<UpstreamResponse> {
  const opened = await open(options, path, init, signal);
  if (!opened.ok) return opened;
  const whole = await readWhole(opened);
  if (!whole.ok) return whole;
  if (!opened.res.ok) {
    return { ok: false, failure: httpFailure(opened.res.status, whole.text, options.secrets) };
  }
  const body = parseJson(whole.text);
  return body === undefined ? { ok: false, failure: { kind: 'network' } } : { ok: true, body };
}

// Спека 002, 4.5: разбор SSE по кускам текста. Событие — блок до пустой строки; строки data: склеиваются через \n,
// один ведущий пробел после "data:" убирается; комментарии и другие поля пропускаются. Строки — \n или \r\n.
// Незавершённое событие на конце потока отбрасывается.
export async function* sseData(texts: AsyncIterable<string>): AsyncGenerator<string> {
  let pending = '';
  let data: string[] = [];
  for await (const text of texts) {
    const lines = (pending + text).split('\n');
    pending = lines.pop() ?? '';
    for (const raw of lines) {
      const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
      if (line === '') {
        if (data.length > 0) yield data.join('\n');
        data = [];
      } else if (line.startsWith('data:')) {
        const value = line.slice(5);
        data.push(value.startsWith(' ') ? value.slice(1) : value);
      }
    }
  }
}

// Причина сбоя потока после старта: таймер, внешний abort (клиент ушёл) или обрыв сети.
function streamFailure(idle: IdleGuard, outer: AbortSignal): UpstreamFailure | { kind: 'aborted' } {
  if (idle.signal.reason === TIMEOUT_REASON) return { kind: 'timeout' };
  return outer.aborted ? { kind: 'aborted' } : { kind: 'network' };
}

// Спека 002, 4.4 и 4.5: payload'ы до [DONE] включительно. Конец тела без [DONE] — network.
async function* payloads(
  res: Response,
  idle: IdleGuard,
  outer: AbortSignal,
): AsyncGenerator<string> {
  let done = false;
  try {
    for await (const data of sseData(textChunks(res, idle.arm))) {
      yield data;
      if (data === DONE) {
        done = true;
        break;
      }
    }
  } catch {
    throw new UpstreamStreamError(streamFailure(idle, outer));
  } finally {
    idle.stop();
  }
  if (!done) throw new UpstreamStreamError({ kind: 'network' });
}

// Поток: отказ до первого фрагмента — как у complete; при 2xx — генератор над телом.
async function openStream(
  options: LiteLlmOptions,
  body: ChatRequest,
  signal: AbortSignal,
): Promise<UpstreamStream> {
  const opened = await open(options, CHAT_PATH, postJson(options, body), signal);
  if (!opened.ok) return opened;
  if (opened.res.ok) return { ok: true, chunks: payloads(opened.res, opened.idle, signal) };
  const whole = await readWhole(opened);
  if (!whole.ok) return whole;
  return { ok: false, failure: httpFailure(opened.res.status, whole.text, options.secrets) };
}

// Спека 002, 4.5: { data: [{ id }] } → ids; иная форма — null.
function modelIds(body: unknown): string[] | null {
  if (typeof body !== 'object' || body === null || !('data' in body) || !Array.isArray(body.data)) {
    return null;
  }
  const ids = body.data.map((item: unknown) =>
    typeof item === 'object' && item !== null && 'id' in item && typeof item.id === 'string'
      ? item.id
      : null,
  );
  return ids.every((id): id is string => id !== null) ? ids : null;
}

export function createLiteLlmUpstream(options: LiteLlmOptions): LlmUpstream {
  return {
    async complete(body: ChatRequest, signal: AbortSignal): Promise<UpstreamResponse> {
      return callUpstream(options, CHAT_PATH, postJson(options, body), signal);
    },
    async stream(body: ChatRequest, signal: AbortSignal): Promise<UpstreamStream> {
      return openStream(options, body, signal);
    },
    async listModels(signal: AbortSignal): Promise<UpstreamModels> {
      const response = await callUpstream(
        options,
        '/v1/models',
        { method: 'GET', headers: authHeaders(options) },
        signal,
      );
      if (!response.ok) return response;
      const ids = modelIds(response.body);
      return ids ? { ok: true, ids } : { ok: false, failure: { kind: 'network' } };
    },
  };
}
