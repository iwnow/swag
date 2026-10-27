import { context, propagation } from '@opentelemetry/api';
import type {
  ChatRequest,
  LlmUpstream,
  UpstreamFailure,
  UpstreamModels,
  UpstreamResponse,
} from '@swag/llm-gateway-core';

// Спека 002, 4.5: адаптер LiteLLM. Поток — следующая задача (T-11).

export interface LiteLlmOptions {
  baseUrl: string; // LITELLM_URL
  masterKey: string; // LITELLM_MASTER_KEY → Authorization: Bearer
  idleTimeoutMs: number; // LLM_GATEWAY_UPSTREAM_TIMEOUT_MS
  secrets: string[]; // значения, которые заменяются на *** в message
  fetch?: typeof fetch; // для тестов; по умолчанию глобальный
}

const MESSAGE_LIMIT = 1000;

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

// Спека 002, 4.5: таймер простоя взводится до запроса и перезапускается на каждом куске тела.
// Сигнал запроса объединяет его с внешним signal; timedOut отличает таймаут от внешнего abort.
function idleGuard(outer: AbortSignal, idleTimeoutMs: number) {
  const own = new AbortController();
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const arm = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      timedOut = true;
      own.abort();
    }, idleTimeoutMs);
  };
  arm();
  return {
    signal: AbortSignal.any([outer, own.signal]),
    arm,
    stop: () => clearTimeout(timer),
    timedOut: () => timedOut,
  };
}

// Тело целиком текстом; arm — на каждом куске.
async function readText(res: Response, arm: () => void): Promise<string> {
  if (!res.body) return '';
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  let chunk = await reader.read();
  while (!chunk.done) {
    arm();
    text += decoder.decode(chunk.value, { stream: true });
    chunk = await reader.read();
  }
  return text + decoder.decode();
}

// Пропагатор глобальный: его ставит startTelemetry из adapter-telemetry; без SDK заголовка не будет.
function authHeaders(options: LiteLlmOptions): Record<string, string> {
  const headers: Record<string, string> = { authorization: `Bearer ${options.masterKey}` };
  propagation.inject(context.active(), headers);
  return headers;
}

// Один вызов апстрима: отказы сети, таймаут и внешний abort, потом статус и разбор JSON.
async function callUpstream(
  options: LiteLlmOptions,
  path: string,
  init: { method: 'GET' | 'POST'; headers: Record<string, string>; body?: string },
  signal: AbortSignal,
): Promise<UpstreamResponse> {
  const idle = idleGuard(signal, options.idleTimeoutMs);
  let res: Response;
  let text: string;
  try {
    res = await (options.fetch ?? fetch)(`${options.baseUrl}${path}`, {
      ...init,
      signal: idle.signal,
    });
    text = await readText(res, idle.arm);
  } catch {
    return { ok: false, failure: idle.timedOut() ? { kind: 'timeout' } : { kind: 'network' } };
  } finally {
    idle.stop();
  }
  if (!res.ok) return { ok: false, failure: httpFailure(res.status, text, options.secrets) };
  const body = parseJson(text);
  return body === undefined ? { ok: false, failure: { kind: 'network' } } : { ok: true, body };
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
      return callUpstream(
        options,
        '/v1/chat/completions',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...authHeaders(options) },
          body: JSON.stringify(body),
        },
        signal,
      );
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
