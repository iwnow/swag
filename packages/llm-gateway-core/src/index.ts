import { z } from 'zod';
import { LlmCaller } from '@swag/contracts';
import type {
  GatewayErrorCode,
  LlmCallData,
  LlmUsage,
  ModelCatalog,
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

// Спека 002, 4.3: cached = min(cachedPromptTokens, promptTokens); результат — округление вверх.
export function costMicroUsd(usage: LlmUsage, prices: ModelPrices): number {
  const cached = BigInt(Math.min(usage.cachedPromptTokens, usage.promptTokens));
  const uncached = BigInt(usage.promptTokens) - cached;
  const total =
    uncached * scaledPrice(prices.inputPerMTokUsd) +
    cached * scaledPrice(prices.cachedInputPerMTokUsd) +
    BigInt(usage.completionTokens) * scaledPrice(prices.outputPerMTokUsd);
  return Number((total + PRICE_SCALE - 1n) / PRICE_SCALE);
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

export type UpstreamResponse =
  { ok: true; body: unknown } | { ok: false; failure: UpstreamFailure };

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

// Спека 002, 4.4. Фабрика ядра; complete — проверки 2–4 из 4.2, вызов (шаги 2–7 без потока, поток — шаги 1–4); обрывы потока — T-18.
export function createLlmGatewayCore(deps: LlmGatewayDeps): LlmGatewayCore {
  const { catalog, upstream, events, clock, ids, trace, log, version } = deps;

  // Событие llm.call и лог `llm call` для обычного вызова: общие для успеха и отказа.
  async function publishCall(data: LlmCallData, caller: LlmCaller, upstreamStatus?: number) {
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
    const fields = callLogFields(data, caller, upstreamStatus);
    if (data.status === 'ok') log.info('llm call', fields);
    else log.warn('llm call', fields);
  }

  // Спека 002, 4.4 (шаг 5) и 4.6: отказ апстрима — событие `error` и ответ клиенту; общий для вызова и потока.
  async function upstreamFailed(
    base: Pick<LlmCallData, 'callId' | 'model' | 'stream' | 'latencyMs'>,
    caller: LlmCaller,
    failure: UpstreamFailure,
  ): Promise<CompleteResult> {
    const reply = upstreamReply(failure);
    await publishCall(
      {
        ...base,
        status: 'error',
        usage: null,
        costMicroUsd: null,
        providerCostMicroUsd: null,
        errorCode: reply.code,
      },
      caller,
      failure.kind === 'http' ? failure.status : undefined,
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
          },
          caller,
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
