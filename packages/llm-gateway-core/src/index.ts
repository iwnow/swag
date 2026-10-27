import type { LlmUsage, ModelPrices } from '@swag/contracts';

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
    cachedPromptTokens: isCount(cached) ? Math.min(cached, promptTokens) : 0,
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
