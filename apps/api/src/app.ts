import type { ApiCore, Result } from '@swag/api-core';
import type { Actor } from '@swag/contracts';
import websocket from '@fastify/websocket';
import Fastify, {
  type FastifyError,
  type FastifyInstance,
  type FastifyReply,
  type FastifyServerOptions,
} from 'fastify';
import { bearerToken, protocolToken, UNAUTHORIZED_CLOSE_CODE, type Authenticator } from './auth.ts';
import type { StreamRegistry } from './streams.ts';

declare module 'fastify' {
  interface FastifyRequest {
    actor: Actor;
  }
}

export interface AppAuth {
  authenticate: Authenticator;
  streams: StreamRegistry;
}

// Оболочка api: REST (4.5.1) и WebSocket (4.5.2). Решений здесь нет — только вход и выход ядра.
export async function buildApp(
  core: ApiCore,
  options: FastifyServerOptions,
  auth: AppAuth,
): Promise<FastifyInstance> {
  const app = Fastify(options);
  await app.register(websocket, { options: { handleProtocols } });

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
    return reply.code(statusOf(result.error.code)).send({ error: result.error });
  };

  // Спека 024, 4.5: проверка токена — onRequest для всех REST-маршрутов, кроме /health и WebSocket (он проверяет сам).
  await app.register(async (rest) => {
    rest.addHook('onRequest', async (request, reply) => {
      const outcome = await auth.authenticate(bearerToken(request.headers.authorization));
      if (outcome.ok) {
        request.actor = outcome.actor;
        return;
      }
      request.log.warn({ reason: outcome.reason }, 'auth_failed');
      if (outcome.reason === 'unavailable') {
        return reply.code(STATUS.auth_unavailable).send({
          error: { code: 'auth_unavailable', message: 'Проверка токенов недоступна' },
        });
      }
      return reply.code(STATUS.unauthorized).send({
        error: { code: 'unauthorized', message: 'Нужна авторизация' },
      });
    });

    rest.post('/swarms', async (request, reply) =>
      send(reply, await core.createSwarm(request.actor, request.body), 201),
    );

    rest.get('/swarms', async (request) => core.listSwarms(request.actor));

    rest.get<{ Params: { id: string } }>('/swarms/:id', async (request, reply) =>
      send(reply, await core.getSwarm(request.actor, request.params.id), 200),
    );

    rest.get<{ Params: { id: string }; Querystring: { after?: string } }>(
      '/swarms/:id/events',
      async (request, reply) =>
        send(
          reply,
          await core.getEvents(request.actor, request.params.id, parseAfter(request.query.after)),
          200,
        ),
    );

    rest.post<{ Params: { id: string } }>('/swarms/:id/stop', async (request, reply) => {
      const result = await core.stopSwarm(request.actor, request.params.id);
      return send(reply, result, 202, () => ({}));
    });
  });

  app.get<{ Params: { id: string }; Querystring: { after?: string } }>(
    '/swarms/:id/stream',
    { websocket: true },
    async (socket, request) => {
      // Освобождение вешается до проверки токена: сокет может закрыться раньше, чем она завершится. Освобождение идемпотентно.
      let release: (() => void) | undefined;
      let unsubscribe: (() => void) | undefined;
      const dispose = () => {
        release?.();
        release = undefined;
        unsubscribe?.();
        unsubscribe = undefined;
      };
      socket.on('close', dispose);
      socket.on('error', dispose);

      const outcome = await auth.authenticate(
        protocolToken(request.headers['sec-websocket-protocol']),
      );
      if (socket.readyState !== socket.OPEN) return;
      if (!outcome.ok) {
        request.log.warn({ reason: outcome.reason }, 'auth_failed');
        socket.close(UNAUTHORIZED_CLOSE_CODE, 'unauthorized');
        return;
      }
      release = auth.streams.add(outcome.actor.userId, socket);
      const subscribed = await core.subscribe(
        outcome.actor,
        request.params.id,
        parseAfter(request.query.after),
        (event) => {
          socket.send(JSON.stringify(event));
        },
      );
      if (!subscribed.ok) {
        socket.close(4404, subscribed.error.code);
        return;
      }
      // Сокет могло закрыть во время подписки: тогда отписываемся сразу.
      if (socket.readyState === socket.OPEN) unsubscribe = subscribed.value;
      else subscribed.value();
    },
  );

  return app;
}

// Спека 024, 4.6: подпротокол swag.v1 — единственный, который сервер выбирает.
function handleProtocols(protocols: Set<string>): string | false {
  return protocols.has('swag.v1') ? 'swag.v1' : false;
}

const STATUS = {
  validation_error: 400,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  too_many_active_swarms: 409,
  swarm_finished: 409,
  auth_unavailable: 503,
} as const;

const statusOf = (code: string): number => (STATUS as Record<string, number>)[code] ?? 500;

function parseAfter(raw: string | undefined): number {
  const value = Number(raw ?? '0');
  return Number.isInteger(value) && value >= 0 ? value : 0;
}
