import type { LlmGatewayCore } from '@swag/llm-gateway-core';
import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';

// Оболочка llm-gateway. Пока только GET /health (спека 002, 4.2); решений здесь нет — только вход и выход ядра.
export async function buildApp(
  core: LlmGatewayCore,
  options: FastifyServerOptions = {},
): Promise<FastifyInstance> {
  const app = Fastify(options);

  // healthcheck compose опрашивает каждые 2 с — в лог только предупреждения, как в apps/api.
  app.get('/health', { logLevel: 'warn' }, async () => ({ status: 'ok', ...core.info() }));

  return app;
}
