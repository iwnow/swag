import { z } from 'zod';
import { LlmCaller } from '@swag/contracts';
import type {
  ChargeBasis,
  GatewayErrorCode,
  LlmCallData,
  LlmCharge,
  LlmSwarmRegistration,
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
  const message = parsed.error.issues
    .slice(0, 3)
    .map((issue) =>
      issue.path.length > 0 ? `${issue.path.join('.')}: ${issue.message}` : issue.message,
    )
    .join('; ');
  return { ok: false, message };
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

// Спека 004, 4.3: usage есть (любой status) — по usage; нет usage при ok/aborted — оценка; error — 0.
export function chargeFor(
  call: {
    status: LlmCallData['status'];
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
}

const CALLER_MESSAGE = 'Missing or invalid x-swag-swarm-id / x-swag-agent-id';
const MODEL_NAME_LIMIT = 100;

// Спека 002, 4.6. Отказ до апстрима: без обращения к LiteLLM и без события.
function refusal(status: number, code: GatewayErrorCode, message: string): CompleteResult {
  return { kind: 'error', status, error: { message, code } };
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
  const { usage, ...rest } = data;
  const fields = {
    swarmId: caller.swarmId,
    agentId: caller.agentId,
    ...rest,
    ...usage,
    upstreamStatus,
  };
  return Object.fromEntries(Object.entries(fields).filter(([, value]) => value != null));
}

const DONE = '[DONE]';

// Спека 002, 4.4 (поток, шаг 3): usage фрагмента и его стоимость у провайдера; фрагмент не JSON или без usage — null.
function chunkUsage(payload: string): { usage: LlmUsage; providerCost: number | null } | null {
  let chunk: unknown;
  try {
    chunk = JSON.parse(payload);
  } catch {
    return null;
  }
  const raw = isRecord(chunk) ? chunk.usage : undefined;
  const usage = parseUsage(raw);
  return usage ? { usage, providerCost: parseProviderCost(raw) } : null;
}

// Спека 002, 4.4. Фабрика ядра; complete — проверки 2–4 из 4.2, вызов (шаги 2–7 без потока, поток — шаги 1–5).
export function createLlmGatewayCore(deps: LlmGatewayDeps): LlmGatewayCore {
  const { catalog, upstream, events, clock, ids, trace, log, version } = deps;

  // Событие llm.call и лог `llm call` для обычного вызова: общие для успеха и отказа.
  async function publishCall(
    data: LlmCallData,
    caller: LlmCaller,
    upstreamStatus?: number,
    level: 'info' | 'warn' = data.status === 'ok' ? 'info' : 'warn',
  ) {
    const event: PlatformEventInput = {
      id: ids.uuid(),
      swarmId: caller.swarmId,
      agentId: caller.agentId,
      ts: clock.now().toISOString(),
      source: 'llm-gateway',
      traceId: trace.currentTraceId(),
      type: 'llm.call',
      data,
    };
    try {
      await events.publishEvent(event);
    } catch (err) {
      log.error('event_publish_failed', { callId: data.callId, err });
    }
    log[level]('llm call', callLogFields(data, caller, upstreamStatus));
  }

  // Спека 002, 4.4 (шаг 5) и 4.6: отказ апстрима — событие `error` и ответ клиенту; общий для вызова и потока.
  // Спека 030, 4.5: обрыв клиентом (aborted) у обычного вызова — событие `aborted` без errorCode, лог info; клиенту — как network.
  async function upstreamFailed(
    base: Pick<LlmCallData, 'callId' | 'model' | 'stream' | 'latencyMs'>,
    caller: LlmCaller,
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
      caller,
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
    prices: ModelPrices,
    caller: LlmCaller,
    signal: UpstreamSignal,
  ): Promise<CompleteResult> {
    const response = await upstream.stream(
      { ...body, stream_options: { ...body.stream_options, include_usage: true } },
      signal,
    );
    if (!response.ok) {
      const latencyMs = Math.round(clock.monotonicMs() - t0); // D-57: до публикации события
      return upstreamFailed(
        { callId, model: body.model, stream: true, latencyMs },
        caller,
        response.failure,
      );
    }
    const payloads = response.chunks;

    async function* relay(): AsyncGenerator<string> {
      let usage: LlmUsage | null = null;
      let providerCost: number | null = null;
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
          const found = chunkUsage(payload);
          if (found) {
            usage = found.usage;
            providerCost = found.providerCost;
          }
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
          caller,
          upstreamStatus,
        );
      }
    }

    return { kind: 'stream', chunks: relay() };
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
        return refusal(400, 'invalid_caller', CALLER_MESSAGE);
      }
      const parsed = parseChatRequest(rawBody);
      if (!parsed.ok) return refusal(400, 'invalid_request', parsed.message);
      const body = parsed.value;
      const entry = catalog.models.find((model) => model.id === body.model);
      if (!entry) {
        const name = Array.from(body.model).slice(0, MODEL_NAME_LIMIT).join('');
        return refusal(400, 'model_not_found', `Unknown model: ${name}`);
      }

      const callId = ids.uuid();
      const t0 = clock.monotonicMs();
      if (body.stream === true) {
        return streamReply(callId, t0, body, entry.prices, caller.data, signal);
      }
      const response = await upstream.complete(body, signal);
      const latencyMs = Math.round(clock.monotonicMs() - t0); // D-57: до публикации события

      if (!response.ok) {
        return upstreamFailed(
          { callId, model: body.model, stream: false, latencyMs },
          caller.data,
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
          costMicroUsd: usage ? costMicroUsd(usage, entry.prices) : null,
          providerCostMicroUsd: usage ? parseProviderCost(rawUsage) : null,
          latencyMs,
        },
        caller.data,
      );
      return { kind: 'json', body: response.body };
    },
  };
}

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
  close(swarmId: string, now: Date): Promise<{ spentMicroUsd: number } | null>; // null — роя нет
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

export interface PriceStore {
  load(): Promise<StoredPrice[]>;
  save(prices: StoredPrice[]): Promise<void>; // upsert одной транзакцией
}
