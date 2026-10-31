import { z } from 'zod';
import { TraceId } from './events.ts';
import { AgentId, SwarmId } from './swarm.ts';

// Спека 016, 4.2. Одна схема структурного лога во всех сервисах.
export const LogLevel = z.enum(['debug', 'info', 'warn', 'error']);
export type LogLevel = z.infer<typeof LogLevel>;

export const ServiceName = z.enum(['api', 'orchestrator', 'agent', 'llm-gateway', 'identity']);
export type ServiceName = z.infer<typeof ServiceName>;

export const LogError = z.strictObject({
  type: z.string(), // имя класса ошибки: Error, ConfigError, NatsError…
  message: z.string(),
  stack: z.string().optional(),
  cause: z.string().optional(), // message причины (error.cause), если есть
});
export type LogError = z.infer<typeof LogError>;

// Лишние поля допустимы: req, res, responseTime от Fastify.
export const LogRecord = z.looseObject({
  time: z.iso.datetime(),
  level: LogLevel,
  service: ServiceName,
  msg: z.string(),
  traceId: TraceId.optional(), // есть, если запись сделана внутри спана
  spanId: z
    .string()
    .regex(/^[0-9a-f]{16}$/)
    .optional(),
  swarmId: SwarmId.optional(),
  agentId: AgentId.optional(),
  err: LogError.optional(),
});
export type LogRecord = z.infer<typeof LogRecord>;
