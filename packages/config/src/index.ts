import { z } from 'zod';
import { LogLevel } from '@swag/contracts';

const Port = z.coerce.number().int().min(1).max(65535);
const PositiveInt = z.coerce.number().int().min(0);
// Спека 016, 4.11: необязательный адрес; не задан или пустая строка — null.
const OptionalUrl = z
  .union([z.literal(''), z.string().url()])
  .optional()
  .transform((value) => (value ? value : null));
const FlushTimeoutMs = PositiveInt.default(2000); // TELEMETRY_FLUSH_TIMEOUT_MS

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
  AGENT_STEP_DELAY_MS: PositiveInt,
  AGENT_START_TIMEOUT_MS: PositiveInt,
  SWARM_TIMEOUT_MS: PositiveInt,
});
export type OrchestratorConfig = z.infer<typeof OrchestratorConfig>;

// Порт UI на 127.0.0.1 — только для проверки инфраструктуры (infra:check); сам UI переменных не читает.
export const UiConfig = z.object({ UI_PORT: Port });
export type UiConfig = z.infer<typeof UiConfig>;

// Спека 016, 4.11: порт Grafana на 127.0.0.1 — для infra:check.
export const ObservabilityConfig = z.object({ GRAFANA_PORT: Port });
export type ObservabilityConfig = z.infer<typeof ObservabilityConfig>;

// Агент не нуждается в DATABASE_URL, поэтому без BaseConfig (4.9).
// Телеметрия агента (016, 4.7): контекст и адрес Collector передаёт оркестратор, пустые строки — нет значения.
// Уровень логов агента — info, оркестратор его не передаёт.
export const AgentConfig = z.object({
  NATS_URL: z.string().url(),
  SWARM_ID: z.uuid(),
  AGENT_ID: z.string().regex(/^agent-[1-9][0-9]?$/),
  AGENT_NAME: z.string().min(1),
  AGENT_ROLE: z.string().min(1),
  AGENT_NEXT: z
    .string()
    .regex(/^(agent-[1-9][0-9]?)?$/)
    .transform((value) => (value === '' ? null : value)),
  AGENT_STEP_DELAY_MS: PositiveInt,
  TRACEPARENT: z
    .string()
    .optional()
    .transform((value) => (value ? value : null)),
  OTEL_EXPORTER_OTLP_ENDPOINT: OptionalUrl,
  TELEMETRY_FLUSH_TIMEOUT_MS: FlushTimeoutMs,
});
export type AgentConfig = z.infer<typeof AgentConfig>;

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
