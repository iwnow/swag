import type { ApiCore } from '@swag/api-core';
import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';

export function buildApp(core: ApiCore, options: FastifyServerOptions = {}): FastifyInstance {
  const app = Fastify(options);
  app.get('/health', async () => ({ status: 'ok', ...core.info() }));
  return app;
}
