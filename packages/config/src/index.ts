import { z } from 'zod';
import { AgentId, LogLevel } from '@swag/contracts';

const Port = z.coerce.number().int().min(1).max(65535);
const PositiveInt = z.coerce.number().int().min(0);
// Спека 016, 4.11: необязательный адрес; не задан или пустая строка — null.
const OptionalUrl = z
  .union([z.literal(''), z.string().url()])
  .optional()
  .transform((value) => (value ? value : null));
const FlushTimeoutMs = PositiveInt.default(2000); // TELEMETRY_FLUSH_TIMEOUT_MS
// Спека 022, 4.8: общий токен gateway; оркестратор и агент получают одно значение.
const GatewayToken = z.string().min(32);
const AgentPeerEnv = z.object({ id: AgentId, name: z.string().min(1), role: z.string().min(1) });

export const BaseConfig = z.object({
  DATABASE_URL: z.string().url(),
  NATS_URL: z.string().url(),
  // Спека 016, 4.11: телеметрия. Пустой OTEL_EXPORTER_OTLP_ENDPOINT — только логи в stdout (REQ-016-6).
  OTEL_EXPORTER_OTLP_ENDPOINT: OptionalUrl,
  LOG_LEVEL: LogLevel.default('info'),
  TELEMETRY_FLUSH_TIMEOUT_MS: FlushTimeoutMs,
});
export type BaseConfig = z.infer<typeof BaseConfig>;

// Спека 001, 4.9. Значения лимитов и таймаутов — env (Q-3).
export const ApiConfig = BaseConfig.extend({
  API_PORT: Port,
  ORCHESTRATOR_URL: z.string().url(),
  MAX_ACTIVE_SWARMS: z.coerce.number().int().min(1),
});
export type ApiConfig = z.infer<typeof ApiConfig>;

export const OrchestratorConfig = BaseConfig.extend({
  ORCHESTRATOR_PORT: Port,
  AGENT_TEMPLATE: z.string().min(1),
  DOCKER_AGENT_NETWORK: z.string().min(1),
  DOCKER_AGENT_NATS_URL: z.string().url(),
  DOCKER_AGENT_OTLP_ENDPOINT: OptionalUrl, // адрес Collector изнутри песочницы (016, 4.7; D-18)
  // Спека 022, 4.8: лимиты агента и адрес gateway изнутри песочницы.
  AGENT_MAX_STEPS: PositiveInt.min(1),
  AGENT_MAX_TOKENS: PositiveInt.min(1),
  LLM_GATEWAY_TOKEN: GatewayToken,
  DOCKER_AGENT_LLM_GATEWAY_URL: z.string().url(),
  AGENT_START_TIMEOUT_MS: PositiveInt,
  SWARM_TIMEOUT_MS: PositiveInt,
});
export type OrchestratorConfig = z.infer<typeof OrchestratorConfig>;

// Порт UI на 127.0.0.1 — только для проверки инфраструктуры (infra:check); сам UI переменных не читает.
export const UiConfig = z.object({ UI_PORT: Port });
export type UiConfig = z.infer<typeof UiConfig>;

// Спека 003, 4.7 и Q-5: срок хранения в часах; меньше 24 — нельзя (Loki удаляет суточными индексами). Без значения по умолчанию.
const RetentionHours = z
  .string()
  .regex(/^[1-9][0-9]*h$/)
  .refine((value) => Number.parseInt(value, 10) >= 24, 'срок хранения не меньше 24h');
// Спека 016, 4.11: порт Grafana на 127.0.0.1 — для infra:check; спека 003, 4.7: срок хранения lgtm.
export const ObservabilityConfig = z.object({
  GRAFANA_PORT: Port,
  TELEMETRY_RETENTION: RetentionHours,
});
export type ObservabilityConfig = z.infer<typeof ObservabilityConfig>;

// Агент не нуждается в DATABASE_URL, поэтому без BaseConfig (4.9).
// Телеметрия агента (016, 4.7): контекст и адрес Collector передаёт оркестратор, пустые строки — нет значения.
// Уровень логов агента — info, оркестратор его не передаёт.
// Спека 022, 4.8: `AGENT_PEERS` — JSON `AgentPeer[]`; ошибка разбора JSON — ошибка переменной.
// Таймаут и повторы вызова модели оркестратор не передаёт — умолчания из 4.8.
export const AgentConfig = z.object({
  NATS_URL: z.string().url(),
  SWARM_ID: z.uuid(),
  AGENT_ID: AgentId,
  AGENT_NAME: z.string().min(1),
  AGENT_ROLE: z.string().min(1),
  AGENT_MODEL: z.string().min(1),
  AGENT_PEERS: z
    .string()
    .transform((value, ctx) => {
      try {
        return JSON.parse(value) as unknown;
      } catch {
        ctx.addIssue({ code: 'custom', message: 'ожидался JSON-массив участников' });
        return z.NEVER;
      }
    })
    .pipe(z.array(AgentPeerEnv)),
  AGENT_ENTRY: AgentId,
  AGENT_MAX_STEPS: PositiveInt.min(1),
  AGENT_MAX_TOKENS: PositiveInt.min(1),
  LLM_GATEWAY_URL: z.string().url(),
  LLM_GATEWAY_TOKEN: GatewayToken,
  AGENT_LLM_TIMEOUT_MS: z.coerce.number().int().min(1).default(120000),
  AGENT_LLM_MAX_RETRIES: PositiveInt.default(2),
  TRACEPARENT: z
    .string()
    .optional()
    .transform((value) => (value ? value : null)),
  OTEL_EXPORTER_OTLP_ENDPOINT: OptionalUrl,
  TELEMETRY_FLUSH_TIMEOUT_MS: FlushTimeoutMs,
});
export type AgentConfig = z.infer<typeof AgentConfig>;

// Спека 002, 4.9. Без BaseConfig: gateway не нужна DATABASE_URL. Ключи провайдеров — только в .env.llm (4.8).
export const LlmGatewayConfig = z.object({
  NATS_URL: z.string().url(),
  OTEL_EXPORTER_OTLP_ENDPOINT: OptionalUrl,
  LOG_LEVEL: LogLevel.default('info'),
  TELEMETRY_FLUSH_TIMEOUT_MS: FlushTimeoutMs,
  LLM_GATEWAY_PORT: Port,
  LLM_GATEWAY_TOKEN: GatewayToken,
  LLM_CATALOG_PATH: z.string().min(1),
  LITELLM_URL: z.string().url(),
  LITELLM_MASTER_KEY: z.string().startsWith('sk-').min(16),
  LLM_GATEWAY_UPSTREAM_TIMEOUT_MS: z.coerce.number().int().min(1).default(120000),
  LLM_GATEWAY_STARTUP_TIMEOUT_MS: z.coerce.number().int().min(1).default(60000),
  LLM_GATEWAY_BODY_LIMIT_BYTES: z.coerce.number().int().min(1024).default(8388608),
});
export type LlmGatewayConfig = z.infer<typeof LlmGatewayConfig>;

export interface ConfigIssue {
  variable: string;
  message: string;
}

export class ConfigError extends Error {
  readonly issues: ConfigIssue[];

  constructor(issues: ConfigIssue[]) {
    super(`Ошибка конфигурации:\n${issues.map((i) => `  ${i.variable}: ${i.message}`).join('\n')}`);
    this.name = 'ConfigError';
    this.issues = issues;
  }
}

export function loadConfig<T extends z.ZodType>(
  schema: T,
  env: Record<string, string | undefined> = process.env,
): z.infer<T> {
  const result = schema.safeParse(env);
  if (!result.success) {
    throw new ConfigError(
      result.error.issues.map((issue) => ({
        variable: issue.path.join('.'),
        message: issue.message,
      })),
    );
  }
  return result.data;
}
