import type { OrchestratorCore } from '@swag/orchestrator-core';
import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';

export function buildApp(
  core: OrchestratorCore,
  options: FastifyServerOptions = {},
): FastifyInstance {
  const app = Fastify(options);
  app.get('/health', async () => ({ status: 'ok', ...core.info() }));
  return app;
}
