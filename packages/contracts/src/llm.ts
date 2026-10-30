import { z } from 'zod';

// Спека 022, 4.1. Модели платформы, одинаковые во всех профилях (002, Q-4). Для выбора в форме роя.
export const PlatformModel = z.enum(['chat-small', 'chat-large']);
export type PlatformModel = z.infer<typeof PlatformModel>;

// Спека 002, 4.1. Имя модели платформы: одинаково во всех профилях (Q-4).
export const ModelId = z.string().regex(/^[a-z][a-z0-9-]{1,39}$/);
export type ModelId = z.infer<typeof ModelId>;

// Деньги — целые micro-USD (спека 004, 4.1). Верхняя граница бюджета роя в контракте; рабочий лимит — SWARM_MAX_BUDGET_MICRO_USD (4.11).
export const MicroUsd = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
export type MicroUsd = z.infer<typeof MicroUsd>;
export const BudgetMicroUsd = z.number().int().min(1).max(1_000_000_000); // до $1000
export type BudgetMicroUsd = z.infer<typeof BudgetMicroUsd>;

// Цена в USD за 1 млн токенов: десятичная строка, не больше 4 знаков после точки, не больше 10000.
export const PricePerMTok = z
  .string()
  .regex(/^\d{1,5}(\.\d{1,4})?$/)
  .refine((v) => Number(v) <= 10000);

export const ModelPrices = z.strictObject({
  inputPerMTokUsd: PricePerMTok, // некэшированные входные токены
  cachedInputPerMTokUsd: PricePerMTok, // входные токены из кэша провайдера
  outputPerMTokUsd: PricePerMTok,
});

export type ModelPrices = z.infer<typeof ModelPrices>;

// openRouterModel — id модели OpenRouter для обновления цен (спека 004, 4.9), только в профилях dev и prod.
export const CatalogModel = z.strictObject({
  id: ModelId,
  prices: ModelPrices,
  openRouterModel: z.string().min(1).optional(),
});

// infra/llm/<профиль>/models.json; id уникальны, порядок задаёт порядок в GET /v1/models.
export const ModelCatalog = z
  .strictObject({ models: z.array(CatalogModel).min(1) })
  .refine((c) => new Set(c.models.map((m) => m.id)).size === c.models.length, {
    message: 'duplicate model id',
  });
export type ModelCatalog = z.infer<typeof ModelCatalog>;

export const LlmUsage = z.strictObject({
  promptTokens: z.number().int().min(0), // все входные токены, включая кэшированные
  cachedPromptTokens: z.number().int().min(0), // ≤ promptTokens после нормализации (4.3)
  completionTokens: z.number().int().min(0),
});
export type LlmUsage = z.infer<typeof LlmUsage>;

export const GatewayErrorCode = z.enum([
  'unauthorized',
  'invalid_caller',
  'invalid_request',
  'model_not_found',
  'caller_not_registered', // 403: роя нет в регистрации, он закрыт или истёк; агента нет в регистрации (004, 4.12)
  'model_not_allowed', // 403: модель запроса не модель агента из регистрации (004, 4.12)
  'swarm_budget_exceeded', // 402 (004, 4.12)
  'agent_budget_exceeded', // 402 (004, 4.12)
  'upstream_bad_request',
  'rate_limited',
  'upstream_error',
  'upstream_timeout',
]);
export type GatewayErrorCode = z.infer<typeof GatewayErrorCode>;

// Списание вызова — то же, что запись ledger (спека 004, 4.3).
export const ChargeBasis = z.enum(['usage', 'estimate', 'none']);
export type ChargeBasis = z.infer<typeof ChargeBasis>;
export const LlmCharge = z.strictObject({ microUsd: MicroUsd, basis: ChargeBasis });
export type LlmCharge = z.infer<typeof LlmCharge>;

export const LlmCallStatus = z.enum(['ok', 'error', 'aborted']);

export const LlmCallData = z.strictObject({
  callId: z.uuid(),
  model: ModelId,
  stream: z.boolean(),
  status: LlmCallStatus,
  usage: LlmUsage.nullable(), // null — провайдер не прислал usage или поток оборван до него
  costMicroUsd: z.number().int().min(0).nullable(), // null тогда и только тогда, когда usage null
  // Фактическая стоимость у провайдера по ключу платформы (usage.cost), для счёта платформы (D-38).
  // null — провайдер или LiteLLM её не прислали. На costMicroUsd не влияет.
  providerCostMicroUsd: z.number().int().min(0).nullable(),
  latencyMs: z.number().int().min(0), // от приёма запроса до последнего байта ответа клиенту
  errorCode: GatewayErrorCode.optional(), // есть при status 'error' и при 'aborted' из-за ошибки после первого фрагмента
  // Что списано (004). costMicroUsd — стоимость по usage (002, 4.3), charge — что списано.
  // Отсутствует только у событий, записанных до спеки 004.
  charge: LlmCharge.optional(),
});
export type LlmCallData = z.infer<typeof LlmCallData>;

// Заголовки вызывающего (Q-3): до спеки 004 агент называет себя сам.
export const SWARM_ID_HEADER = 'x-swag-swarm-id';
export const AGENT_ID_HEADER = 'x-swag-agent-id';
