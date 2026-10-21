import type { ApiCore } from '@swag/api-core';
import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';

export function buildApp(core: ApiCore, options: FastifyServerOptions = {}): FastifyInstance {
  const app = Fastify(options);
  // healthcheck compose опрашивает каждые 2 с — в лог только предупреждения.
  app.get('/health', { logLevel: 'warn' }, async () => ({ status: 'ok', ...core.info() }));
  return app;
}
