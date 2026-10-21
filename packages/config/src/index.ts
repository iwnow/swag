import { z } from 'zod';

export const BaseConfig = z.object({
  DATABASE_URL: z.string().url(),
  NATS_URL: z.string().url(),
});
export type BaseConfig = z.infer<typeof BaseConfig>;

const Port = z.coerce.number().int().min(1).max(65535);

export const ApiConfig = BaseConfig.extend({ API_PORT: Port });
export type ApiConfig = z.infer<typeof ApiConfig>;

export const OrchestratorConfig = BaseConfig.extend({ ORCHESTRATOR_PORT: Port });
export type OrchestratorConfig = z.infer<typeof OrchestratorConfig>;

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
