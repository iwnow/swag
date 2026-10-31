import { bearerMatches } from '@swag/helpers/server';
import type { OrchestratorCore } from '@swag/orchestrator-core';
import Fastify, {
  type FastifyError,
  type FastifyInstance,
  type FastifyServerOptions,
} from 'fastify';

export interface AppSettings {
  token: string; // ORCHESTRATOR_TOKEN, спека 024, 4.13
}

// Оболочка оркестратора: HTTP 4.6.1 (вызывает только api). Решений здесь нет.
export function buildApp(
  core: OrchestratorCore,
  options: FastifyServerOptions,
  settings: AppSettings,
): FastifyInstance {
  const app = Fastify(options);
  // healthcheck compose опрашивает каждые 2 с — в лог только предупреждения.
  app.get('/health', { logLevel: 'warn' }, async () => ({ status: 'ok', ...core.info() }));

  // Спека 024, 4.13: токен проверяется до разбора тела и до ядра; заголовок в лог не пишется.
  app.addHook('onRequest', async (request, reply) => {
    if (request.routeOptions.url === '/health') return;
    if (!bearerMatches(request.headers.authorization, settings.token)) {
      return reply
        .code(401)
        .send({ error: { code: 'unauthorized', message: 'Invalid orchestrator token' } });
    }
  });

  app.setErrorHandler((error: FastifyError, _request, reply) => {
    const status = error.statusCode ?? 500;
    if (status >= 500) app.log.error({ err: error }, 'request failed');
    void reply.code(status).send({
      error: {
        code: status === 400 ? 'validation_error' : 'internal_error',
        message: error.message,
      },
    });
  });

  app.post('/swarms', async (request, reply) => {
    const result = await core.launch(request.body);
    if (result.ok) return reply.code(202).send({});
    const status = result.error.code === 'swarm_exists' ? 409 : 400;
    return reply.code(status).send({ error: result.error });
  });

  app.post<{ Params: { id: string } }>('/swarms/:id/stop', async (request, reply) => {
    const result = await core.stop(request.params.id);
    if (result.ok) return reply.code(202).send({});
    return reply.code(404).send({ error: result.error });
  });

  return app;
}
