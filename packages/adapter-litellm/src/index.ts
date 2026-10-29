import {
  SpanKind,
  SpanStatusCode,
  context,
  propagation,
  trace,
  type Span,
} from '@opentelemetry/api';
import {
  UpstreamStreamError,
  parseUsage,
  type ChatRequest,
  type LlmUpstream,
  type UpstreamFailure,
  type UpstreamModels,
  type UpstreamResponse,
  type UpstreamStream,
} from '@swag/llm-gateway-core';

// Спека 002, 4.5: адаптер LiteLLM.

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
const TRACER = '@swag/adapter-litellm';

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
  return { kind: 'http', status, message: redact(message, secrets).slice(0, MESSAGE_LIMIT) };
}

// Спека 002, 4.5: спан litellm.chat, вид client. Тела запроса и ответа в атрибуты не попадают.
function startChatSpan(body: ChatRequest, stream: boolean): Span {
  return trace.getTracer(TRACER).startSpan('litellm.chat', {
    kind: SpanKind.CLIENT,
    attributes: { 'gen_ai.request.model': body.model, 'swag.llm.stream': stream },
  });
}

// Спан активен на время вызова: traceparent, который инжектирует authHeaders, несёт его контекст.
const inSpanContext = <T>(span: Span, run: () => T): T =>
  context.with(trace.setSpan(context.active(), span), run);

type LlmUsage = NonNullable<ReturnType<typeof parseUsage>>;

function failSpan(span: Span): void {
  span.setStatus({ code: SpanStatusCode.ERROR });
}

function setUsage(span: Span, usage: LlmUsage | null): void {
  if (usage === null) return;
  span.setAttributes({
    'gen_ai.usage.input_tokens': usage.promptTokens,
    'gen_ai.usage.output_tokens': usage.completionTokens,
  });
}

// usage тела ответа или фрагмента потока; нет поля или не по форме — null.
const usageOf = (body: unknown): LlmUsage | null =>
  typeof body === 'object' && body !== null && 'usage' in body ? parseUsage(body.usage) : null;

const usageOfPayload = (payload: string): LlmUsage | null =>
  payload === DONE ? null : usageOf(parseJson(payload));

// Спека 002, 4.5: спан заканчивается по концу генератора — и при [DONE], и при раннем выходе, и при ошибке.
// usage берётся из последнего фрагмента, где он есть (как в ядре, 4.4).
async function* observeStream(chunks: AsyncIterable<string>, span: Span): AsyncGenerator<string> {
  let usage: LlmUsage | null = null;
  try {
    for await (const payload of chunks) {
      usage = usageOfPayload(payload) ?? usage;
      yield payload;
    }
  } catch (error) {
    failSpan(span);
    throw error;
  } finally {
    setUsage(span, usage);
    span.end();
  }
}

// Причина срабатывания таймера: по ней отличаем таймаут от внешнего abort.
const TIMEOUT_REASON = Symbol('idle-timeout');

// Спека 002, 4.5: таймер простоя взводится до запроса. Сигнал запроса объединяет его с внешним signal;
// AbortSignal.any отдаёт reason первого сработавшего источника.
// arm взводит таймер, только если он не идёт; stop снимает его. Чтение тела взводит перед каждым ожиданием куска
// и снимает после куска, поэтому пауза потребителя между фрагментами в простой не входит.
function idleGuard(outer: AbortSignal, idleTimeoutMs: number) {
  const own = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const arm = () => {
    if (timer === undefined) timer = setTimeout(() => own.abort(TIMEOUT_REASON), idleTimeoutMs);
  };
  const stop = () => {
    clearTimeout(timer);
    timer = undefined;
  };
  arm();
  return { signal: AbortSignal.any([outer, own.signal]), arm, stop };
}

type IdleGuard = ReturnType<typeof idleGuard>;

type CallFailure = UpstreamFailure | { kind: 'aborted' };

// Спека 002, 4.5 и 030, 4.5: сбой запроса, чтения тела или потока. Таймер → timeout; внешний signal (клиент ушёл) → aborted; иначе network.
function transportFailure(idle: IdleGuard, outer: AbortSignal): CallFailure {
  if (idle.signal.reason === TIMEOUT_REASON) return { kind: 'timeout' };
  return outer.aborted ? { kind: 'aborted' } : { kind: 'network' };
}

// Поток и listModels остаются на network при внешнем abort: спека 030 меняет только обычный вызов (complete).
const withoutAborted = (failure: CallFailure): UpstreamFailure =>
  failure.kind === 'aborted' ? { kind: 'network' } : failure;

// Куски тела текстом. Таймер идёт только пока ждём кусок от апстрима; yield (пауза потребителя) его не касается.
// Раннее закрытие потребителем, ошибка или конец тела снимают таймер и отменяют чтение: соединение закрывается.
async function* textChunks(res: Response, idle: IdleGuard): AsyncGenerator<string> {
  if (!res.body) return;
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  try {
    for (;;) {
      idle.arm();
      const chunk = await reader.read();
      idle.stop();
      if (chunk.done) break;
      yield decoder.decode(chunk.value, { stream: true });
    }
    yield decoder.decode();
  } finally {
    idle.stop();
    reader.cancel().catch(() => {});
  }
}

async function readText(res: Response, idle: IdleGuard): Promise<string> {
  let text = '';
  for await (const part of textChunks(res, idle)) text += part;
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

type Opened = { ok: true; res: Response; idle: IdleGuard } | { ok: false; failure: CallFailure };

// Заголовки ответа. Отказ до заголовков — failure. При успехе таймер остаётся взведённым: его снимает тот, кто читает тело.
async function open(
  options: LiteLlmOptions,
  path: string,
  init: Init,
  signal: AbortSignal,
  span?: Span,
): Promise<Opened> {
  const idle = idleGuard(signal, options.idleTimeoutMs);
  try {
    const res = await (options.fetch ?? fetch)(`${options.baseUrl}${path}`, {
      ...init,
      signal: idle.signal,
    });
    span?.setAttribute('http.response.status_code', res.status);
    return { ok: true, res, idle };
  } catch {
    idle.stop();
    return { ok: false, failure: transportFailure(idle, signal) };
  }
}

// Тело целиком; таймер снимается по окончании чтения.
async function readWhole(
  opened: { res: Response; idle: IdleGuard },
  outer: AbortSignal,
): Promise<{ ok: true; text: string } | { ok: false; failure: CallFailure }> {
  try {
    return { ok: true, text: await readText(opened.res, opened.idle) };
  } catch {
    return { ok: false, failure: transportFailure(opened.idle, outer) };
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
  span?: Span,
): Promise<UpstreamResponse> {
  const opened = await open(options, path, init, signal, span);
  if (!opened.ok) return opened;
  const whole = await readWhole(opened, signal);
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

// Спека 002, 4.4 и 4.5: payload'ы до [DONE] включительно. Конец тела без [DONE] — network.
// Ошибка чтения превращается в UpstreamStreamError; yield вне try, чтобы throw() потребителя не перехватывался.
async function* payloads(
  res: Response,
  idle: IdleGuard,
  outer: AbortSignal,
): AsyncGenerator<string> {
  const parts = sseData(textChunks(res, idle));
  try {
    for (;;) {
      let next: IteratorResult<string>;
      try {
        next = await parts.next();
      } catch {
        throw new UpstreamStreamError(transportFailure(idle, outer));
      }
      if (next.done) break;
      yield next.value;
      if (next.value === DONE) return;
    }
  } finally {
    await parts.return(undefined);
    idle.stop();
  }
  throw new UpstreamStreamError({ kind: 'network' });
}

// Поток: отказ до первого фрагмента — как у complete; при 2xx таймер снимается до первого next(), генератор над телом.
async function openStream(
  options: LiteLlmOptions,
  body: ChatRequest,
  signal: AbortSignal,
  span: Span,
): Promise<UpstreamStream> {
  const opened = await open(options, CHAT_PATH, postJson(options, body), signal, span);
  if (!opened.ok) return { ok: false, failure: withoutAborted(opened.failure) };
  if (opened.res.ok) {
    opened.idle.stop();
    return { ok: true, chunks: payloads(opened.res, opened.idle, signal) };
  }
  const whole = await readWhole(opened, signal);
  if (!whole.ok) return { ok: false, failure: withoutAborted(whole.failure) };
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
      const span = startChatSpan(body, false);
      try {
        const response = await inSpanContext(span, () =>
          callUpstream(options, CHAT_PATH, postJson(options, body), signal, span),
        );
        if (response.ok) setUsage(span, usageOf(response.body));
        else failSpan(span);
        return response;
      } finally {
        span.end();
      }
    },
    async stream(body: ChatRequest, signal: AbortSignal): Promise<UpstreamStream> {
      const span = startChatSpan(body, true);
      let result: UpstreamStream;
      try {
        result = await inSpanContext(span, () => openStream(options, body, signal, span));
      } catch (error) {
        failSpan(span);
        span.end();
        throw error;
      }
      if (!result.ok) {
        failSpan(span);
        span.end();
        return result;
      }
      return { ok: true, chunks: observeStream(result.chunks, span) };
    },
    async listModels(signal: AbortSignal): Promise<UpstreamModels> {
      const response = await callUpstream(
        options,
        '/v1/models',
        { method: 'GET', headers: authHeaders(options) },
        signal,
      );
      if (!response.ok) return { ok: false, failure: withoutAborted(response.failure) };
      const ids = modelIds(response.body);
      return ids ? { ok: true, ids } : { ok: false, failure: { kind: 'network' } };
    },
  };
}
