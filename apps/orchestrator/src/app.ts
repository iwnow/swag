import type { OrchestratorCore } from '@swag/orchestrator-core';
import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';

export function buildApp(
  core: OrchestratorCore,
  options: FastifyServerOptions = {},
): FastifyInstance {
  const app = Fastify(options);
  // healthcheck compose опрашивает каждые 2 с — в лог только предупреждения.
  app.get('/health', { logLevel: 'warn' }, async () => ({ status: 'ok', ...core.info() }));
  return app;
}
