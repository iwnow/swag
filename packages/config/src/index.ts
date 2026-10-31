import { z } from 'zod';
import { AgentId, Email, LogLevel, Password } from '@swag/contracts';

const Port = z.coerce.number().int().min(1).max(65535);
const PositiveInt = z.coerce.number().int().min(0);
// Спека 016, 4.11: необязательный адрес; не задан или пустая строка — null.
const OptionalUrl = z
  .union([z.literal(''), z.string().url()])
  .optional()
  .transform((value) => (value ? value : null));
const FlushTimeoutMs = PositiveInt.default(2000); // TELEMETRY_FLUSH_TIMEOUT_MS
// Спека 022, 4.8: общий токен gateway; оркестратор и агент получают одно значение.
// Спека 024, 4.14: тот же формат для внутренних токенов сервисов (identity, оркестратор).
const ServiceToken = z.string().min(32);
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
  // Спека 004, 4.11: предел бюджета роя в micro-USD (Q-5).
  SWARM_MAX_BUDGET_MICRO_USD: z.coerce.number().int().min(1),
  // Спека 031, 4.2: предел maxTokens роя и агента.
  AGENT_MAX_TOKENS_LIMIT: z.coerce.number().int().min(1),
  // Спека 013, 4.10: предел одного пополнения баланса организации в micro-USD.
  BALANCE_MAX_TOPUP_MICRO_USD: z.coerce.number().int().min(1).max(1000000000).default(100000000),
  // Спека 024, 4.14: проверка токенов и отзывов (identity), вызов оркестратора.
  IDENTITY_URL: z.string().url(),
  IDENTITY_INTERNAL_TOKEN: ServiceToken,
  IDENTITY_JWT_PUBLIC_KEY: z.string().min(1), // base64 от SPKI PEM (D-117)
  IDENTITY_JWT_KID: z.string().min(1),
  ORCHESTRATOR_TOKEN: ServiceToken,
  API_REVOCATION_POLL_MS: z.coerce.number().int().min(1000).default(5000),
  API_REVOCATION_MAX_STALE_MS: z.coerce.number().int().min(1000).default(30000),
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
  LLM_GATEWAY_TOKEN: ServiceToken,
  DOCKER_AGENT_LLM_GATEWAY_URL: z.string().url(),
  // Спека 004, 4.11: внутренний API gateway (регистрация роёв) — без /v1, как база для /internal/*.
  LLM_GATEWAY_URL: z.string().url(),
  AGENT_START_TIMEOUT_MS: PositiveInt,
  SWARM_TIMEOUT_MS: PositiveInt,
  // Спека 024, 4.13–4.14: Bearer-токен, которым api вызывает оркестратор.
  ORCHESTRATOR_TOKEN: ServiceToken,
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
  LLM_GATEWAY_TOKEN: ServiceToken,
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

// Спека 002, 4.9; спека 004, 4.11: DATABASE_URL — бюджеты, ledger и цены. Без BaseConfig. Ключи провайдеров — только в .env.llm (4.8).
export const LlmGatewayConfig = z.object({
  DATABASE_URL: z.string().url(),
  NATS_URL: z.string().url(),
  OTEL_EXPORTER_OTLP_ENDPOINT: OptionalUrl,
  LOG_LEVEL: LogLevel.default('info'),
  TELEMETRY_FLUSH_TIMEOUT_MS: FlushTimeoutMs,
  LLM_GATEWAY_PORT: Port,
  LLM_GATEWAY_TOKEN: ServiceToken,
  LLM_CATALOG_PATH: z.string().min(1),
  LITELLM_URL: z.string().url(),
  LITELLM_MASTER_KEY: z.string().startsWith('sk-').min(16),
  LLM_GATEWAY_UPSTREAM_TIMEOUT_MS: z.coerce.number().int().min(1).default(120000),
  LLM_GATEWAY_STARTUP_TIMEOUT_MS: z.coerce.number().int().min(1).default(60000),
  LLM_GATEWAY_CLOSE_WAIT_MS: z.coerce.number().int().min(0).max(8000).default(5000), // спека 013, 4.10
  LLM_GATEWAY_BODY_LIMIT_BYTES: z.coerce.number().int().min(1024).default(8388608),
  LLM_PROFILE: z.enum(['test', 'dev', 'test-pay', 'prod']), // спека 002, 4.8; 032, 4.1; test не обращается к OpenRouter (004, 4.9)
  LLM_PRICES_REFRESH_MS: z.coerce.number().int().min(0).default(3600000), // спека 004, 4.11; 0 — выключено
  OPENROUTER_MODELS_URL: z.string().url().default('https://openrouter.ai/api/v1/models'), // спека 004, 4.11
});
export type LlmGatewayConfig = z.infer<typeof LlmGatewayConfig>;

// Спека 012, 4.10. Пустая строка супервизора — не задано (как OptionalUrl).
const OptionalSupervisor = <T extends z.ZodType>(schema: T) =>
  z.preprocess((value) => (value === '' ? undefined : value), schema.optional());

export const IdentityConfig = z
  .object({
    DATABASE_URL: z.string().url(),
    OTEL_EXPORTER_OTLP_ENDPOINT: OptionalUrl,
    LOG_LEVEL: LogLevel.default('info'),
    TELEMETRY_FLUSH_TIMEOUT_MS: FlushTimeoutMs,
    IDENTITY_PORT: Port,
    IDENTITY_CONFIRM_URL: z.string().url(), // страница UI (014); в dev http://127.0.0.1:4200/auth/confirm
    IDENTITY_JWT_PRIVATE_KEY: z.string().min(1), // PKCS8 PEM Ed25519 в base64 одной строкой (Q-2)
    IDENTITY_JWT_KID: z.string().min(1),
    IDENTITY_ACCESS_TTL_S: z.coerce.number().int().min(60).default(900),
    IDENTITY_REFRESH_TTL_S: z.coerce.number().int().min(3600).default(2592000),
    IDENTITY_CONFIRM_TTL_S: z.coerce.number().int().min(600).default(86400),
    IDENTITY_COOKIE_SECURE: z.enum(['true', 'false']).transform((value) => value === 'true'),
    IDENTITY_BODY_LIMIT_BYTES: z.coerce.number().int().min(1024).default(16384),
    IDENTITY_SUPERVISOR_EMAIL: OptionalSupervisor(Email), // задаются вместе с паролем или оба пусты (superRefine ниже)
    IDENTITY_SUPERVISOR_PASSWORD: OptionalSupervisor(Password),
    SMTP_URL: z.string().url(), // dev: smtp://mailpit:1025
    SMTP_TIMEOUT_MS: z.coerce.number().int().min(1).default(10000),
    MAIL_FROM: z.string().min(3), // dev: Swag <no-reply@swag.local>
    // Спека 024, 4.14: внутренний токен отзывов, страница приглашения в UI (014) и срок приглашения.
    IDENTITY_INTERNAL_TOKEN: ServiceToken,
    IDENTITY_INVITE_URL: z.string().url(), // dev: http://127.0.0.1:4200/auth/invite
    IDENTITY_INVITE_TTL_S: z.coerce.number().int().min(600).default(604800),
  })
  .superRefine((config, ctx) => {
    const emailMissing = config.IDENTITY_SUPERVISOR_EMAIL === undefined;
    if (emailMissing === (config.IDENTITY_SUPERVISOR_PASSWORD === undefined)) return;
    ctx.addIssue({
      code: 'custom',
      path: [emailMissing ? 'IDENTITY_SUPERVISOR_EMAIL' : 'IDENTITY_SUPERVISOR_PASSWORD'],
      message: 'IDENTITY_SUPERVISOR_EMAIL и IDENTITY_SUPERVISOR_PASSWORD задаются вместе',
    });
  });
export type IdentityConfig = z.infer<typeof IdentityConfig>;

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
