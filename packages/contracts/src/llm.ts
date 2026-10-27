import { z } from 'zod';
import { AgentId, SwarmId } from './swarm.ts';

// Спека 002, 4.1. Имя модели платформы: одинаково во всех профилях (Q-4).
export const ModelId = z.string().regex(/^[a-z][a-z0-9-]{1,39}$/);
export type ModelId = z.infer<typeof ModelId>;

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

export const CatalogModel = z.strictObject({ id: ModelId, prices: ModelPrices });

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
  'upstream_bad_request',
  'rate_limited',
  'upstream_error',
  'upstream_timeout',
]);
export type GatewayErrorCode = z.infer<typeof GatewayErrorCode>;

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
});
export type LlmCallData = z.infer<typeof LlmCallData>;

// Заголовки вызывающего (Q-3): до спеки 004 агент называет себя сам.
export const SWARM_ID_HEADER = 'x-swag-swarm-id';
export const AGENT_ID_HEADER = 'x-swag-agent-id';
export const LlmCaller = z.strictObject({ swarmId: SwarmId, agentId: AgentId });
export type LlmCaller = z.infer<typeof LlmCaller>;
