import { z } from 'zod';
import { LlmCaller, LlmSwarmRegistration, PricePerMTok, SwarmId } from '@swag/contracts';
import type {
  ChargeBasis,
  GatewayErrorCode,
  LlmCallData,
  LlmCallStatus,
  LlmCharge,
  LlmSwarmClosed,
  LlmUsage,
  ModelCatalog,
  ModelId,
  ModelPrices,
  PlatformEventInput,
  ServiceInfo,
} from '@swag/contracts';

// Спека 002, 4.2. Поля сверх перечисленных пропускаются как есть.
export const ChatRequest = z.looseObject({
  model: z.string(), // проверка по каталогу отдельно → model_not_found
  messages: z.array(z.looseObject({ role: z.string() })).min(1),
  stream: z.boolean().optional(),
  stream_options: z.looseObject({}).optional(),
});
export type ChatRequest = z.infer<typeof ChatRequest>;

// REQ-002-18. Ключ и адрес провайдера задаёт только платформа; ключ организации (D-35) подставит сам gateway.
export const CLIENT_CREDENTIAL_FIELDS = [
  'api_key',
  'api_base',
  'base_url',
  'api_version',
  'organization',
  'extra_headers',
  'user_config',
] as const;

export type ChatRequestParse = { ok: true; value: ChatRequest } | { ok: false; message: string };

// Спека 002, 4.2 и 4.6. Сначала поля провайдера, потом схема; message — текст invalid_request.
export function parseChatRequest(raw: unknown): ChatRequestParse {
  const credentialField = isRecord(raw)
    ? CLIENT_CREDENTIAL_FIELDS.find((field) => Object.hasOwn(raw, field))
    : undefined;
  if (credentialField) {
    return {
      ok: false,
      message: `Client-side provider credentials are not allowed: ${credentialField}`,
    };
  }
  const parsed = ChatRequest.safeParse(raw);
  if (parsed.success) return { ok: true, value: parsed.data };
  return { ok: false, message: zodMessage(parsed.error) };
}

// Спека 002, 4.6. Первые три ошибки Zod как `path: message`, через `; `.
function zodMessage(error: z.ZodError): string {
  return error.issues
    .slice(0, 3)
    .map((issue) =>
      issue.path.length > 0 ? `${issue.path.join('.')}: ${issue.message}` : issue.message,
    )
    .join('; ');
}

// Спека 002, 4.3. Цены — целые × 10⁴: "3.00" → 30000, "0.0001" → 1.
const PRICE_SCALE = 10_000n;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isCount = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0;

function scaledPrice(price: string): bigint {
  const [whole = '0', fraction = ''] = price.split('.');
  return BigInt(whole) * PRICE_SCALE + BigInt(fraction.padEnd(4, '0'));
}

// Спека 002, 4.3 и 004, 4.3: сумма в масштабе цен (× 10⁴) → micro-USD, округление вверх.
function ceilMicroUsd(scaledTotal: bigint): number {
  return Number((scaledTotal + PRICE_SCALE - 1n) / PRICE_SCALE);
}

// Спека 002, 4.3: cached = min(cachedPromptTokens, promptTokens); результат — округление вверх.
export function costMicroUsd(usage: LlmUsage, prices: ModelPrices): number {
  const cached = BigInt(Math.min(usage.cachedPromptTokens, usage.promptTokens));
  const uncached = BigInt(usage.promptTokens) - cached;
  const total =
    uncached * scaledPrice(prices.inputPerMTokUsd) +
    cached * scaledPrice(prices.cachedInputPerMTokUsd) +
    BigInt(usage.completionTokens) * scaledPrice(prices.outputPerMTokUsd);
  return ceilMicroUsd(total);
}

// Спека 004, 4.3. Байты — UTF-8; токен модели не меньше байта, поэтому байты — верхняя граница токенов (Q-3).
const utf8 = new TextEncoder();
const utf8Length = (text: string): number => utf8.encode(text).length;

// Спека 004, 4.3: длина в UTF-8 строки JSON от messages и tools (по умолчанию []).
export function inputBytes(body: ChatRequest): number {
  return utf8Length(JSON.stringify({ messages: body.messages, tools: body.tools ?? [] }));
}

// Спека 004, 4.3: оценка по байтам входа и выхода — общая для резерва и списания без usage.
function estimateMicroUsd(bytesIn: number, bytesOut: number, prices: ModelPrices): number {
  return ceilMicroUsd(
    BigInt(bytesIn) * scaledPrice(prices.inputPerMTokUsd) +
      BigInt(bytesOut) * scaledPrice(prices.outputPerMTokUsd),
  );
}

// Спека 004, 4.3: holdMicroUsd = ceil((inputBytes·p_in + maxOut·p_out) / 10⁴).
export function holdMicroUsd(inputBytes: number, maxOut: number, prices: ModelPrices): number {
  return estimateMicroUsd(inputBytes, maxOut, prices);
}

// Спека 004, 4.3: длина в UTF-8 у content и tool_calls[].function.arguments одного message или delta.
export function outputBytes(message: unknown): number {
  if (!isRecord(message)) return 0;
  let bytes = typeof message.content === 'string' ? utf8Length(message.content) : 0;
  if (Array.isArray(message.tool_calls)) {
    for (const call of message.tool_calls) {
      const fn = isRecord(call) ? call.function : undefined;
      if (isRecord(fn) && typeof fn.arguments === 'string') bytes += utf8Length(fn.arguments);
    }
  }
  return bytes;
}

// Спека 004, 4.3: сумма outputBytes по choices[].message (без потока) или choices[].delta (фрагмент потока).
function choicesOutputBytes(payload: unknown, field: 'message' | 'delta'): number {
  if (!isRecord(payload) || !Array.isArray(payload.choices)) return 0;
  return payload.choices.reduce(
    (sum: number, choice: unknown) =>
      sum + outputBytes(isRecord(choice) ? choice[field] : undefined),
    0,
  );
}

// Спека 004, 4.3: usage есть (любой status) — по usage; нет usage при ok/aborted — оценка; error — 0.
export function chargeFor(
  call: {
    status: LlmCallStatus;
    usage: LlmUsage | null;
    inputBytes: number;
    outputBytes: number;
  },
  prices: ModelPrices,
): LlmCharge {
  if (call.usage) return { microUsd: costMicroUsd(call.usage, prices), basis: 'usage' };
  if (call.status === 'error') return { microUsd: 0, basis: 'none' };
  return {
    microUsd: estimateMicroUsd(call.inputBytes, call.outputBytes, prices),
    basis: 'estimate',
  };
}

// Спека 002, 4.3. Нет prompt_tokens или completion_tokens — usage считается отсутствующим.
export function parseUsage(raw: unknown): LlmUsage | null {
  if (!isRecord(raw)) return null;
  const { prompt_tokens: promptTokens, completion_tokens: completionTokens } = raw;
  if (!isCount(promptTokens) || !isCount(completionTokens)) return null;
  const details = raw.prompt_tokens_details;
  const cached = isRecord(details) ? details.cached_tokens : undefined;
  return {
    promptTokens,
    cachedPromptTokens: isCount(cached) ? cached : 0,
    completionTokens,
  };
}

// Спека 002, 4.3. usage.cost — кредиты (1 кредит = $1); micro-USD округляются до ближайшего.
export function parseProviderCost(raw: unknown): number | null {
  if (!isRecord(raw)) return null;
  const cost = raw.cost;
  if (typeof cost !== 'number' || !Number.isFinite(cost) || cost < 0) return null;
  return Math.round(cost * 1_000_000);
}

// Спека 004, 4.9. Цены OpenRouter: строка за токен × 10⁶ → строка за 1 млн токенов, без Number.
const DECIMAL = /^\d+(\.\d+)?$/;
const TOKENS_PER_MTOK_DIGITS = 6;
const EXTRA_CHARGE_FIELDS = ['request', 'image', 'web_search'] as const;

// Десятичный сдвиг на 6 знаков; больше 4 знаков после точки — округление вверх; null — не разобрано или не PricePerMTok.
function perMTokPrice(perToken: unknown): string | null {
  if (typeof perToken !== 'string' || !DECIMAL.test(perToken)) return null;
  const [whole = '0', fraction = ''] = perToken.split('.');
  const point = whole.length + TOKENS_PER_MTOK_DIGITS;
  const digits = (whole + fraction).padEnd(point, '0');
  const rest = digits.slice(point);
  const roundUp = /[1-9]/.test(rest.slice(4)) ? 1n : 0n;
  const scaled = BigInt(digits.slice(0, point) + rest.slice(0, 4).padEnd(4, '0')) + roundUp;
  const text = scaled.toString().padStart(5, '0');
  const fractionText = text.slice(-4).replace(/0+$/, '');
  const price = `${BigInt(text.slice(0, -4))}${fractionText ? `.${fractionText}` : ''}`;
  return PricePerMTok.safeParse(price).success ? price : null;
}

// Спека 004, 4.9: request, image, web_search — пропуск, если не нулевые или не разобраны (отсутствие поля — ноль).
function extraChargeReason(pricing: Record<string, unknown>): string | null {
  for (const field of EXTRA_CHARGE_FIELDS) {
    const value = pricing[field];
    if (value === undefined || value === null) continue;
    if (typeof value !== 'string' || !DECIMAL.test(value)) return `invalid pricing.${field}`;
    if (/[1-9]/.test(value)) return `non-zero pricing.${field}`;
  }
  return null;
}

type PricesParse = { prices: ModelPrices } | { reason: string };

// Спека 004, 4.9: prompt → inputPerMTokUsd, completion → outputPerMTokUsd, input_cache_read → cachedInputPerMTokUsd (нет — prompt).
function pricesFromPricing(pricing: Record<string, unknown>): PricesParse {
  const extra = extraChargeReason(pricing);
  if (extra) return { reason: extra };
  const inputPerMTokUsd = perMTokPrice(pricing.prompt);
  if (inputPerMTokUsd === null) return { reason: 'invalid pricing.prompt' };
  const outputPerMTokUsd = perMTokPrice(pricing.completion);
  if (outputPerMTokUsd === null) return { reason: 'invalid pricing.completion' };
  const cachedInputPerMTokUsd =
    pricing.input_cache_read == null ? inputPerMTokUsd : perMTokPrice(pricing.input_cache_read);
  if (cachedInputPerMTokUsd === null) return { reason: 'invalid pricing.input_cache_read' };
  return { prices: { inputPerMTokUsd, cachedInputPerMTokUsd, outputPerMTokUsd } };
}

// Сравнение по значению: "3" и "3.00" равны.
function samePrices(a: ModelPrices, b: ModelPrices): boolean {
  return (
    scaledPrice(a.inputPerMTokUsd) === scaledPrice(b.inputPerMTokUsd) &&
    scaledPrice(a.cachedInputPerMTokUsd) === scaledPrice(b.cachedInputPerMTokUsd) &&
    scaledPrice(a.outputPerMTokUsd) === scaledPrice(b.outputPerMTokUsd)
  );
}

export type PriceChange = { model: ModelId; from: ModelPrices; to: ModelPrices };
export type PriceSkip = { model: ModelId; reason: string };

// Спека 004, 4.9. Чистая: модели с openRouterModel берут цены из data[] ответа с тем же id; остальные не меняются.
// Ответ не того вида (нет data[]) — пустой список, все такие модели в skipped (D-96).
export function applyOpenRouterPrices(
  catalog: ModelCatalog,
  response: unknown,
): { catalog: ModelCatalog; changed: PriceChange[]; skipped: PriceSkip[] } {
  const offers = new Map<string, Record<string, unknown>>();
  if (isRecord(response) && Array.isArray(response.data)) {
    for (const offer of response.data) {
      if (isRecord(offer) && typeof offer.id === 'string' && !offers.has(offer.id)) {
        offers.set(offer.id, offer);
      }
    }
  }
  const changed: PriceChange[] = [];
  const skipped: PriceSkip[] = [];
  const models = catalog.models.map((model) => {
    if (model.openRouterModel === undefined) return model;
    const offer = offers.get(model.openRouterModel);
    if (!offer) {
      skipped.push({ model: model.id, reason: 'not in OpenRouter response' });
      return model;
    }
    if (!isRecord(offer.pricing)) {
      skipped.push({ model: model.id, reason: 'no pricing' });
      return model;
    }
    const parsed = pricesFromPricing(offer.pricing);
    if ('reason' in parsed) {
      skipped.push({ model: model.id, reason: parsed.reason });
      return model;
    }
    if (samePrices(model.prices, parsed.prices)) return model;
    changed.push({ model: model.id, from: model.prices, to: parsed.prices });
    return { ...model, prices: parsed.prices };
  });
  return { catalog: { ...catalog, models }, changed, skipped };
}

// Спека 004, 4.9. Чистая: модель с openRouterModel и сохранённой ценой берёт её (ключ — openRouterModel, не id модели платформы).
export function applyStoredPrices(catalog: ModelCatalog, stored: StoredPrice[]): ModelCatalog {
  const byOpenRouterModel = new Map(stored.map((price) => [price.openRouterModel, price.prices]));
  return {
    ...catalog,
    models: catalog.models.map((model) => {
      const prices =
        model.openRouterModel === undefined
          ? undefined
          : byOpenRouterModel.get(model.openRouterModel);
      return prices === undefined ? model : { ...model, prices };
    }),
  };
}

// Спека 002, 4.4. Порт апстрима: обычный вызов, поток и список моделей.
export type UpstreamFailure =
  | { kind: 'http'; status: number; message: string } // message уже без секретов (4.5)
  | { kind: 'network' }
  | { kind: 'timeout' };

// Спека 030, 4.5: aborted — внешний signal (клиент ушёл); для обычного вызова публикуется как aborted, а не error.
export type UpstreamResponse =
  { ok: true; body: unknown } | { ok: false; failure: UpstreamFailure | { kind: 'aborted' } };

export type UpstreamModels = { ok: true; ids: string[] } | { ok: false; failure: UpstreamFailure };

// Спека 002, 4.4. Отказ до первого фрагмента — { ok: false }; дальше обрыв, таймаут или abort — исключение из итератора.
export type UpstreamStream =
  { ok: true; chunks: AsyncIterable<string> } | { ok: false; failure: UpstreamFailure };

// Спека 002, 4.4. Причина сбоя потока после старта; kind 'aborted' — внешний signal (клиент ушёл).
// Поле объявлено явно, а не параметром-свойством: Node запускает .ts без трансформации (strip-only).
export class UpstreamStreamError extends Error {
  readonly failure: UpstreamFailure | { kind: 'aborted' };

  constructor(failure: UpstreamFailure | { kind: 'aborted' }) {
    super(failure.kind);
    this.failure = failure;
  }
}

// Спека 002, 4.4 пишет AbortSignal. Ядро собирается без DOM и @types/node (architecture.md), поэтому тип структурный:
// подходит любой AbortSignal; ядро только передаёт сигнал дальше.
export interface UpstreamSignal {
  readonly aborted: boolean;
}

export interface LlmUpstream {
  // Обычный вызов. Тело уже проверено ядром.
  complete(body: ChatRequest, signal: UpstreamSignal): Promise<UpstreamResponse>;
  // Поток: payload'ы событий SSE без префикса "data: ", включая '[DONE]'.
  // Обрыв, таймаут или abort после старта — исключение UpstreamStreamError из итератора.
  stream(body: ChatRequest, signal: UpstreamSignal): Promise<UpstreamStream>;
  // Список моделей апстрима (GET /v1/models). Отказ — как у complete.
  listModels(signal: UpstreamSignal): Promise<UpstreamModels>;
}

// Спека 002, 4.4. Порты ядра: адаптеры собирает оболочка. Имена и поля — по 4.4 (D-55).
export interface EventPublisher {
  publishEvent(event: PlatformEventInput): Promise<void>;
}

export interface Clock {
  now(): Date;
  monotonicMs(): number;
}

export interface Ids {
  uuid(): string;
}

// Как в 016 (api-core): текущий traceId или null вне трейса.
export interface TraceContext {
  currentTraceId(): string | null;
}

// Как в api-core (спека 016, REQ-016-10): контекст лога — только id, числа и перечисления.
export type LogContext = {
  swarmId?: string;
  agentId?: string;
  err?: unknown;
  [key: string]: unknown;
};

export interface Logger {
  debug(msg: string, ctx?: LogContext): void;
  info(msg: string, ctx?: LogContext): void;
  warn(msg: string, ctx?: LogContext): void;
  error(msg: string, ctx?: LogContext): void;
}

export interface LlmGatewayDeps {
  catalog: ModelCatalog; // уже разобран оболочкой
  upstream: LlmUpstream;
  events: EventPublisher;
  clock: Clock;
  ids: Ids;
  trace: TraceContext;
  log: Logger;
  version: string;
  budgets: BudgetStore; // спека 004, 4.4
  prices: PriceBook; // цены модели для списания; catalog остаётся списком моделей
  sleep: (ms: number) => Promise<void>; // спека 013, 4.7: ожидание списаний при закрытии роя
  closeWaitMs: number; // LLM_GATEWAY_CLOSE_WAIT_MS, спека 013, 4.10
}

export type CompleteResult =
  | { kind: 'json'; body: unknown }
  | { kind: 'stream'; chunks: AsyncIterable<string> } // payload'ы для записи клиенту
  | { kind: 'error'; status: number; error: { message: string; code: GatewayErrorCode } };

export type CheckUpstreamResult =
  { ok: true } | { ok: false; missing: string[] } | { ok: false; failure: UpstreamFailure };

export type ModelList = {
  object: 'list';
  data: { id: string; object: 'model'; owned_by: 'swag' }[];
};

export interface LlmGatewayCore {
  info(): ServiceInfo;
  listModels(): ModelList;
  // Сверка каталога: ok — все id каталога есть в upstream; иначе список недостающих.
  checkUpstream(signal: UpstreamSignal): Promise<CheckUpstreamResult>;
  // rawCaller — значения заголовков как пришли; signal — обрыв клиентом.
  complete(
    rawCaller: { swarmId?: string; agentId?: string },
    rawBody: unknown,
    signal: UpstreamSignal,
  ): Promise<CompleteResult>;
  // Спека 004, 4.4: регистрация роя; ошибка — InternalResult.
  registerSwarm(raw: unknown): Promise<InternalResult<void>>;
  closeSwarm(swarmId: string): Promise<InternalResult<LlmSwarmClosed>>;
  // Снимает резервы прошлого процесса без списания; возвращает их число (лог warn hold_released на каждый).
  releaseHolds(): Promise<number>;
}

const CALLER_MESSAGE = 'Missing or invalid x-swag-swarm-id / x-swag-agent-id';
const MODEL_NAME_LIMIT = 100;

// Спека 002, 4.6. Отказ до апстрима: без обращения к LiteLLM и без события.
function refusal(status: number, code: GatewayErrorCode, message: string): CompleteResult {
  return { kind: 'error', status, error: { message, code } };
}

// Спека 004, 4.4. Ошибка внутреннего API (регистрация роя, закрытие): без записи в БД.
function internalError(
  status: number,
  code: InternalErrorCode,
  message: string,
): InternalResult<never> {
  return { ok: false, status, error: { message, code } };
}

// Спека 002, 4.6. Отказ апстрима → статус, код и message клиенту; статус апстрима сюда не попадает (только в лог).
function upstreamReply(failure: UpstreamFailure): {
  status: number;
  code: GatewayErrorCode;
  message: string;
} {
  if (failure.kind === 'timeout') {
    return { status: 504, code: 'upstream_timeout', message: 'Upstream timeout' };
  }
  if (failure.kind === 'http') {
    if (failure.status === 400 || failure.status === 422) {
      return { status: 400, code: 'upstream_bad_request', message: failure.message };
    }
    if (failure.status === 429) {
      return { status: 429, code: 'rate_limited', message: 'Provider rate limit' };
    }
  }
  return { status: 502, code: 'upstream_error', message: 'Upstream error' };
}

// Спека 002, 4.10. Поля лога — из данных события и upstreamStatus; null/undefined не пишутся.
function callLogFields(data: LlmCallData, caller: LlmCaller, upstreamStatus?: number): LogContext {
  const { usage, charge, ...rest } = data;
  const fields = {
    swarmId: caller.swarmId,
    agentId: caller.agentId,
    ...rest,
    ...usage,
    chargeMicroUsd: charge?.microUsd,
    chargeBasis: charge?.basis,
    upstreamStatus,
  };
  return Object.fromEntries(Object.entries(fields).filter(([, value]) => value != null));
}

const DONE = '[DONE]';

// Спека 004, 4.3: что нужно списанию вызова, кроме итога апстрима. Байты выхода — у вызова отдельно.
interface Settlement {
  caller: LlmCaller;
  prices: ModelPrices;
  bytesIn: number;
  holdMicroUsd: number;
  settled: boolean; // settle уже вызван: повторно не списываем (4.3)
}

type LlmCallBase = Omit<LlmCallData, 'charge'>;

// Спека 002, 4.4 (поток, шаг 3) и 004, 4.3: usage фрагмента с его стоимостью у провайдера и байты его delta; фрагмент не JSON — null.
function parseChunk(payload: string): {
  usage: LlmUsage | null;
  providerCost: number | null;
  deltaBytes: number;
} | null {
  let chunk: unknown;
  try {
    chunk = JSON.parse(payload);
  } catch {
    return null;
  }
  const raw = isRecord(chunk) ? chunk.usage : undefined;
  const usage = parseUsage(raw);
  return {
    usage,
    providerCost: usage ? parseProviderCost(raw) : null,
    deltaBytes: choicesOutputBytes(chunk, 'delta'),
  };
}

// Спека 002, 4.4. Фабрика ядра; complete — проверки 2–4 из 4.2, вызов (шаги 2–7 без потока, поток — шаги 1–5).
export function createLlmGatewayCore(deps: LlmGatewayDeps): LlmGatewayCore {
  const {
    catalog,
    upstream,
    events,
    clock,
    ids,
    trace,
    log,
    version,
    budgets,
    prices: priceBook,
    sleep,
    closeWaitMs,
  } = deps;

  // Спека 004, 4.3 и 4.4: отказ на шагах 2–7 — без события, лог warn `call_refused` с кодом.
  // До разбора вызывающего (шаг 2) ids неизвестны и в лог не пишутся.
  function refuseCall(
    status: number,
    code: GatewayErrorCode,
    message: string,
    caller?: LlmCaller,
  ): CompleteResult {
    log.warn('call_refused', { code, ...caller });
    return refusal(status, code, message);
  }

  // Спека 004, 4.3 (списание) и 002, 4.4 (событие `llm.call` и лог `llm call`): общие для успеха и отказа.
  // Списание пишется до публикации; сбой записи не меняет ответ клиенту (REQ-004-13).
  async function publishCall(
    base: LlmCallBase,
    settlement: Settlement,
    bytesOut: number,
    upstreamStatus?: number,
    level: 'info' | 'warn' = base.status === 'ok' ? 'info' : 'warn',
  ) {
    const { caller, prices, bytesIn, holdMicroUsd: hold } = settlement;
    const charge = chargeFor(
      { status: base.status, usage: base.usage, inputBytes: bytesIn, outputBytes: bytesOut },
      prices,
    );
    const data: LlmCallData = { ...base, charge };
    const ts = clock.now().toISOString();
    settlement.settled = true;
    try {
      await budgets.settle({
        callId: base.callId,
        ts,
        swarmId: caller.swarmId,
        agentId: caller.agentId,
        model: base.model,
        kind: 'llm',
        amountMicroUsd: charge.microUsd,
        basis: charge.basis,
        providerCostMicroUsd: base.providerCostMicroUsd,
      });
    } catch (err) {
      log.error('settle_failed', { callId: base.callId, err });
    }
    if (charge.microUsd > hold) {
      log.warn('hold_exceeded', {
        callId: base.callId,
        holdMicroUsd: hold,
        chargeMicroUsd: charge.microUsd,
      });
    }
    const event: PlatformEventInput = {
      id: ids.uuid(),
      swarmId: caller.swarmId,
      agentId: caller.agentId,
      ts,
      source: 'llm-gateway',
      traceId: trace.currentTraceId(),
      type: 'llm.call',
      data,
    };
    try {
      await events.publishEvent(event);
    } catch (err) {
      log.error('event_publish_failed', { callId: base.callId, err });
    }
    log[level]('llm call', callLogFields(data, caller, upstreamStatus));
  }

  // Спека 002, 4.4 (шаг 5) и 4.6: отказ апстрима — событие `error` и ответ клиенту; общий для вызова и потока.
  // Спека 030, 4.5: обрыв клиентом (aborted) у обычного вызова — событие `aborted` без errorCode, лог info; клиенту — как network.
  async function upstreamFailed(
    base: Pick<LlmCallData, 'callId' | 'model' | 'stream' | 'latencyMs'>,
    settlement: Settlement,
    failure: UpstreamFailure | { kind: 'aborted' },
  ): Promise<CompleteResult> {
    const aborted = failure.kind === 'aborted';
    const reply = upstreamReply(failure.kind === 'aborted' ? { kind: 'network' } : failure);
    await publishCall(
      {
        ...base,
        status: aborted ? 'aborted' : 'error',
        usage: null,
        costMicroUsd: null,
        providerCostMicroUsd: null,
        ...(aborted ? {} : { errorCode: reply.code }),
      },
      settlement,
      0,
      failure.kind === 'http' ? failure.status : undefined,
      aborted ? 'info' : undefined,
    );
    return {
      kind: 'error',
      status: reply.status,
      error: { message: reply.message, code: reply.code },
    };
  }

  // Спека 002, 4.4, поток (шаги 1–4). Фрагменты уходят клиенту без изменений; событие и лог — в finally генератора.
  async function streamReply(
    callId: string,
    t0: number,
    body: ChatRequest,
    settlement: Settlement,
    signal: UpstreamSignal,
  ): Promise<CompleteResult> {
    const { prices } = settlement;
    const response = await upstream.stream(
      { ...body, stream_options: { ...body.stream_options, include_usage: true } },
      signal,
    );
    if (!response.ok) {
      const latencyMs = Math.round(clock.monotonicMs() - t0); // D-57: до публикации события
      return upstreamFailed(
        { callId, model: body.model, stream: true, latencyMs },
        settlement,
        response.failure,
      );
    }
    const payloads = response.chunks;

    async function* relay(): AsyncGenerator<string> {
      let usage: LlmUsage | null = null;
      let providerCost: number | null = null;
      let bytesOut = 0; // байты delta фрагментов, дошедших до клиента (4.3)
      let done = false;
      let reply: ReturnType<typeof upstreamReply> | null = null;
      let upstreamStatus: number | undefined;
      try {
        for await (const payload of payloads) {
          if (payload === DONE) {
            done = true;
            yield payload;
            break;
          }
          const chunk = parseChunk(payload);
          if (chunk?.usage) {
            usage = chunk.usage;
            providerCost = chunk.providerCost;
          }
          bytesOut += chunk?.deltaBytes ?? 0;
          yield payload;
        }
      } catch (err) {
        // Спека 002, 4.4 (шаг 5): обрыв апстрима после старта отдаём клиенту последним payload; клиент ушёл — исключение дальше.
        if (!(err instanceof UpstreamStreamError) || err.failure.kind === 'aborted') throw err;
        reply = upstreamReply(err.failure);
        upstreamStatus = err.failure.kind === 'http' ? err.failure.status : undefined;
        yield JSON.stringify({
          error: { message: reply.message, type: 'swag_gateway_error', code: reply.code },
        });
      } finally {
        // D-59: latencyMs замеряется в finally, то есть по концу потока.
        const latencyMs = Math.round(clock.monotonicMs() - t0);
        await publishCall(
          {
            callId,
            model: body.model,
            stream: true,
            status: done ? 'ok' : 'aborted',
            usage,
            costMicroUsd: usage ? costMicroUsd(usage, prices) : null,
            providerCostMicroUsd: providerCost,
            latencyMs,
            ...(reply ? { errorCode: reply.code } : {}),
          },
          settlement,
          bytesOut,
          upstreamStatus,
        );
      }
    }

    return { kind: 'stream', chunks: relay() };
  }

  // Спека 002, 4.4 (шаги 5–6) и 004, 4.3: обычный вызов; списание и событие — до ответа клиенту.
  async function jsonReply(
    callId: string,
    t0: number,
    body: ChatRequest,
    settlement: Settlement,
    signal: UpstreamSignal,
  ): Promise<CompleteResult> {
    const response = await upstream.complete(body, signal);
    const latencyMs = Math.round(clock.monotonicMs() - t0); // D-57: до публикации события

    if (!response.ok) {
      return upstreamFailed(
        { callId, model: body.model, stream: false, latencyMs },
        settlement,
        response.failure,
      );
    }

    const rawUsage = isRecord(response.body) ? response.body.usage : undefined;
    const usage = parseUsage(rawUsage);
    if (!usage) log.warn('usage_missing', { callId });
    await publishCall(
      {
        callId,
        model: body.model,
        stream: false,
        status: 'ok',
        usage,
        costMicroUsd: usage ? costMicroUsd(usage, settlement.prices) : null,
        providerCostMicroUsd: usage ? parseProviderCost(rawUsage) : null,
        latencyMs,
      },
      settlement,
      choicesOutputBytes(response.body, 'message'),
    );
    return { kind: 'json', body: response.body };
  }

  return {
    info: () => ({ service: 'llm-gateway', version }),

    listModels: () => ({
      object: 'list',
      data: catalog.models.map((model): ModelList['data'][number] => ({
        id: model.id,
        object: 'model',
        owned_by: 'swag',
      })),
    }),

    async checkUpstream(signal) {
      const result = await upstream.listModels(signal);
      if (!result.ok) return { ok: false, failure: result.failure };
      const available = new Set(result.ids);
      const missing = catalog.models.map((model) => model.id).filter((id) => !available.has(id));
      return missing.length === 0 ? { ok: true } : { ok: false, missing };
    },

    async complete(rawCaller, rawBody, signal) {
      const caller = LlmCaller.safeParse({
        swarmId: rawCaller.swarmId,
        agentId: rawCaller.agentId,
      });
      if (!caller.success) {
        return refuseCall(400, 'invalid_caller', CALLER_MESSAGE);
      }
      const parsed = parseChatRequest(rawBody);
      if (!parsed.ok) return refuseCall(400, 'invalid_request', parsed.message, caller.data);
      const body = parsed.value;
      if (!catalog.models.some((model) => model.id === body.model)) {
        const name = Array.from(body.model).slice(0, MODEL_NAME_LIMIT).join('');
        return refuseCall(400, 'model_not_found', `Unknown model: ${name}`, caller.data);
      }

      // Спека 004, 4.2 (шаг 5) и 4.3 (шаги 7–8): регистрация роя и агента, max_tokens, резерв до апстрима.
      const agent = await budgets.findAgent(caller.data.swarmId, caller.data.agentId);
      if (!agent || agent.closed || (agent.expiresAt !== null && agent.expiresAt <= clock.now())) {
        return refuseCall(
          403,
          'caller_not_registered',
          'Swarm or agent is not registered',
          caller.data,
        );
      }
      if (agent.model !== body.model) {
        return refuseCall(
          403,
          'model_not_allowed',
          'Model is not allowed for this agent',
          caller.data,
        );
      }
      const maxOut = body.max_tokens ?? body.max_completion_tokens;
      if (!isCount(maxOut) || maxOut < 1) {
        return refuseCall(400, 'invalid_request', 'max_tokens is required', caller.data);
      }
      const modelPrices = priceBook.prices(body.model);
      const bytesIn = inputBytes(body);
      const hold = holdMicroUsd(bytesIn, maxOut, modelPrices);
      const callId = ids.uuid();
      const t0 = clock.monotonicMs();
      // Резерв до апстрима (4.3, шаг 8): сбой резерва — исключение без события, резерва нет.
      const reserved = await budgets.reserve(callId, caller.data, hold, clock.now());
      if (!reserved.ok) {
        log.warn('budget_exceeded', {
          swarmId: caller.data.swarmId,
          agentId: caller.data.agentId,
          holdMicroUsd: hold,
          code: reserved.code,
        });
        return refusal(
          402,
          reserved.code,
          reserved.code === 'swarm_budget_exceeded'
            ? 'Swarm budget exceeded'
            : 'Agent budget exceeded',
        );
      }
      const settlement: Settlement = {
        caller: caller.data,
        prices: modelPrices,
        bytesIn,
        holdMicroUsd: hold,
        settled: false,
      };
      try {
        return body.stream === true
          ? await streamReply(callId, t0, body, settlement, signal)
          : await jsonReply(callId, t0, body, settlement, signal);
      } catch (err) {
        // Сбой после резерва вне порта апстрима: резерв закрывается как сетевой отказ (charge 0, 4.3), ошибка уходит дальше.
        if (!settlement.settled) {
          await upstreamFailed(
            {
              callId,
              model: body.model,
              stream: body.stream === true,
              latencyMs: Math.round(clock.monotonicMs() - t0),
            },
            settlement,
            { kind: 'network' },
          );
        }
        throw err;
      }
    },

    async registerSwarm(raw) {
      const parsed = LlmSwarmRegistration.safeParse(raw);
      if (!parsed.success) return internalError(400, 'invalid_request', zodMessage(parsed.error));
      const reg = parsed.data;
      if (
        reg.agents.some(
          (agent) => agent.budgetMicroUsd !== null && agent.budgetMicroUsd > reg.budgetMicroUsd,
        )
      ) {
        return internalError(400, 'invalid_request', 'agent budget exceeds swarm budget');
      }
      if (reg.agents.some((agent) => !catalog.models.some((model) => model.id === agent.model))) {
        return internalError(400, 'model_not_found', 'Unknown model');
      }
      const registered = await budgets.register(reg, clock.now());
      return registered
        ? { ok: true, value: undefined }
        : internalError(409, 'swarm_registered', 'Swarm is already registered');
    },

    async closeSwarm(swarmId) {
      // Не UUID не может быть ни одним роем: 404, а не ошибка Postgres на приведении типа (4.2).
      if (!SwarmId.safeParse(swarmId).success) {
        return internalError(404, 'not_found', 'Swarm not found');
      }
      // Спека 013, 4.7: закрытие ждёт списания идущих вызовов, но не дольше closeWaitMs.
      const startedAt = clock.monotonicMs();
      let totals = await budgets.close(swarmId, clock.now());
      if (!totals) return internalError(404, 'not_found', 'Swarm not found');
      while (totals.heldMicroUsd > 0 && clock.monotonicMs() - startedAt < closeWaitMs) {
        await sleep(CLOSE_POLL_MS);
        totals = (await budgets.totals(swarmId)) ?? totals;
      }
      if (totals.heldMicroUsd > 0) {
        log.warn('close_holds_pending', { swarmId, heldMicroUsd: totals.heldMicroUsd });
      }
      return {
        ok: true,
        value: { spentMicroUsd: totals.spentMicroUsd, heldMicroUsd: totals.heldMicroUsd },
      };
    },

    async releaseHolds() {
      const released = await budgets.releaseHolds();
      for (const hold of released) {
        log.warn('hold_released', {
          swarmId: hold.swarmId,
          callId: hold.callId,
          amountMicroUsd: hold.amountMicroUsd,
        });
      }
      return released.length;
    },
  };
}

// Спека 013, 4.7: шаг опроса хранилища, пока закрытие роя ждёт списания.
const CLOSE_POLL_MS = 100;

// Спека 004, 4.4. Порты денег: только интерфейсы, логика — в T-5 (ядро) и в адаптере (T-3).
export interface RegisteredAgent {
  model: ModelId;
  expiresAt: Date | null;
  closed: boolean;
}

export type ReserveResult =
  { ok: true } | { ok: false; code: 'swarm_budget_exceeded' | 'agent_budget_exceeded' };

export interface BudgetStore {
  // Рой и его агенты одной транзакцией; false — рой уже есть.
  register(reg: LlmSwarmRegistration, now: Date): Promise<boolean>;
  findAgent(swarmId: string, agentId: string): Promise<RegisteredAgent | null>;
  // Атомарно: held += amount у роя и (если бюджет задан) у агента — только если spent + held + amount ≤ budget.
  reserve(
    callId: string,
    caller: LlmCaller,
    amountMicroUsd: number,
    now: Date,
  ): Promise<ReserveResult>;
  // Одна транзакция: удалить резерв callId, held −= резерв, spent += charge, запись ledger.
  settle(entry: LedgerEntry): Promise<void>;
  close(
    swarmId: string,
    now: Date,
  ): Promise<{ spentMicroUsd: number; heldMicroUsd: number } | null>; // null — роя нет
  // Спека 013, 4.7: суммы роя для ожидания списаний при закрытии; null — роя нет.
  totals(swarmId: string): Promise<{ spentMicroUsd: number; heldMicroUsd: number } | null>;
  releaseHolds(): Promise<{ callId: string; swarmId: string; amountMicroUsd: number }[]>;
}

export interface LedgerEntry {
  callId: string;
  ts: string;
  swarmId: string;
  agentId: string;
  model: ModelId;
  kind: 'llm';
  amountMicroUsd: number; // = charge.microUsd
  basis: ChargeBasis;
  providerCostMicroUsd: number | null;
}

// Последние успешные цены OpenRouter (4.9), ключ — openRouterModel.
export interface StoredPrice {
  openRouterModel: string;
  prices: ModelPrices;
  updatedAt: Date;
}

// Спека 004, 4.4. Текущие цены модели платформы (каталог обновляется из OpenRouter, 4.9).
export interface PriceBook {
  prices(model: ModelId): ModelPrices;
}

// Спека 004, 4.4. Внутренний API (регистрация, закрытие): коды 4.2.
export type InternalErrorCode =
  'invalid_request' | 'model_not_found' | 'swarm_registered' | 'not_found';
export type InternalResult<T> =
  | { ok: true; value: T }
  | { ok: false; status: number; error: { message: string; code: InternalErrorCode } };

export interface PriceStore {
  load(): Promise<StoredPrice[]>;
  save(prices: StoredPrice[]): Promise<void>; // upsert одной транзакцией
}
