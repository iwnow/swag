import { z } from 'zod';
import type { LlmUsage, ModelPrices } from '@swag/contracts';

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

// Спека 002, 4.4. Порт апстрима: сейчас обычный вызов и список моделей (stream — T-11).
export type UpstreamFailure =
  | { kind: 'http'; status: number; message: string } // message уже без секретов (4.5)
  | { kind: 'network' }
  | { kind: 'timeout' };

export type UpstreamResponse =
  { ok: true; body: unknown } | { ok: false; failure: UpstreamFailure };

export type UpstreamModels = { ok: true; ids: string[] } | { ok: false; failure: UpstreamFailure };

// Спека 002, 4.4 пишет AbortSignal. Ядро собирается без DOM и @types/node (architecture.md), поэтому тип структурный:
// подходит любой AbortSignal; ядро только передаёт сигнал дальше.
export interface UpstreamSignal {
  readonly aborted: boolean;
}

export interface LlmUpstream {
  // Обычный вызов. Тело уже проверено ядром.
  complete(body: ChatRequest, signal: UpstreamSignal): Promise<UpstreamResponse>;
  // Список моделей апстрима (GET /v1/models). Отказ — как у complete.
  listModels(signal: UpstreamSignal): Promise<UpstreamModels>;
}
