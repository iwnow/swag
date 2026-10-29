import type { ApiCore, Result } from '@swag/api-core';
import websocket from '@fastify/websocket';
import Fastify, {
  type FastifyError,
  type FastifyInstance,
  type FastifyReply,
  type FastifyServerOptions,
} from 'fastify';

// Оболочка api: REST (4.5.1) и WebSocket (4.5.2). Решений здесь нет — только вход и выход ядра.
export async function buildApp(
  core: ApiCore,
  options: FastifyServerOptions = {},
): Promise<FastifyInstance> {
  const app = Fastify(options);
  await app.register(websocket);

  // healthcheck compose опрашивает каждые 2 с — в лог только предупреждения.
  app.get('/health', { logLevel: 'warn' }, async () => ({ status: 'ok', ...core.info() }));

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

  const send = <T>(
    reply: FastifyReply,
    result: Result<T>,
    okStatus: number,
    body?: (value: T) => unknown,
  ) => {
    if (result.ok) return reply.code(okStatus).send(body ? body(result.value) : result.value);
    const status = STATUS[result.error.code] ?? 500;
    return reply.code(status).send({ error: result.error });
  };

  app.post('/swarms', async (request, reply) =>
    send(reply, await core.createSwarm(request.body), 201),
  );

  app.get('/swarms', async () => core.listSwarms());

  app.get<{ Params: { id: string } }>('/swarms/:id', async (request, reply) =>
    send(reply, await core.getSwarm(request.params.id), 200),
  );

  app.get<{ Params: { id: string }; Querystring: { after?: string } }>(
    '/swarms/:id/events',
    async (request, reply) =>
      send(reply, await core.getEvents(request.params.id, parseAfter(request.query.after)), 200),
  );

  app.post<{ Params: { id: string } }>('/swarms/:id/stop', async (request, reply) => {
    const result = await core.stopSwarm(request.params.id);
    return send(reply, result, 202, () => ({}));
  });

  app.get<{ Params: { id: string }; Querystring: { after?: string } }>(
    '/swarms/:id/stream',
    { websocket: true },
    async (socket, request) => {
      const subscribed = core.subscribe(
        request.params.id,
        parseAfter(request.query.after),
        (event) => {
          socket.send(JSON.stringify(event));
        },
      );
      // Сокет может закрыться раньше, чем подписка установится: тогда отписываемся сразу после её получения.
      socket.on('close', () => {
        void subscribed.then(
          (result) => {
            if (result.ok) result.value();
          },
          () => undefined,
        );
      });
      const result = await subscribed;
      if (!result.ok) socket.close(4404, result.error.code);
    },
  );

  return app;
}

const STATUS: Record<string, number> = {
  validation_error: 400,
  not_found: 404,
  too_many_active_swarms: 409,
  swarm_finished: 409,
};

function parseAfter(raw: string | undefined): number {
  const value = Number(raw ?? '0');
  return Number.isInteger(value) && value >= 0 ? value : 0;
}
