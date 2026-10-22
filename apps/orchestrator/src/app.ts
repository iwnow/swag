import type { OrchestratorCore } from '@swag/orchestrator-core';
import Fastify, {
  type FastifyError,
  type FastifyInstance,
  type FastifyServerOptions,
} from 'fastify';

// Оболочка оркестратора: HTTP 4.6.1 (вызывает только api). Решений здесь нет.
export function buildApp(
  core: OrchestratorCore,
  options: FastifyServerOptions = {},
): FastifyInstance {
  const app = Fastify(options);
  // healthcheck compose опрашивает каждые 2 с — в лог только предупреждения.
  app.get('/health', { logLevel: 'warn' }, async () => ({ status: 'ok', ...core.info() }));

  app.setErrorHandler((error: FastifyError, _request, reply) => {
    const status = error.statusCode ?? 500;
    if (status >= 500) app.log.error(error);
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
