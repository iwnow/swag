import { tracedHttpServer, type Telemetry } from '@swag/adapter-telemetry';
import { bearerMatches } from '@swag/helpers/server';
import { AGENT_ID_HEADER, SWARM_ID_HEADER, type GatewayErrorCode } from '@swag/contracts';
import type { CompleteResult, InternalErrorCode, LlmGatewayCore } from '@swag/llm-gateway-core';
import Fastify, {
  type FastifyError,
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
  type FastifyServerOptions,
} from 'fastify';

// Опции Fastify телеметрии (4.10, REQ-002-14): логгер телеметрии и серверный спан на каждый запрос, кроме /health.
// Общие для main.ts и тестов телеметрии, чтобы тесты проверяли то же подключение, что процесс.
export function telemetryAppOptions(telemetry: Telemetry): FastifyServerOptions {
  return {
    loggerInstance: telemetry.logger.pino,
    serverFactory: tracedHttpServer(telemetry, { ignorePaths: ['/health'] }),
  };
}

// Оболочка llm-gateway (спека 002, 4.2): токен, вход в ядро и выход ядра. Решений здесь нет — только вход и выход ядра.
// gateway.token — LLM_GATEWAY_TOKEN, gateway.bodyLimitBytes — LLM_GATEWAY_BODY_LIMIT_BYTES (REQ-002-3).
export async function buildApp(
  core: LlmGatewayCore,
  gateway: { token: string; bodyLimitBytes: number },
  options: FastifyServerOptions = {},
): Promise<FastifyInstance> {
  const app = Fastify({ bodyLimit: gateway.bodyLimitBytes, ...options });

  // healthcheck compose опрашивает каждые 2 с — в лог только предупреждения, как в apps/api.
  app.get('/health', { logLevel: 'warn' }, async () => ({ status: 'ok', ...core.info() }));

  // Токен проверяется в onRequest: до разбора тела, поэтому чужой запрос не доходит до ядра и не читается целиком.
  // Тот же токен на /v1/* (002) и /internal/* (004, REQ-004-7).
  const authorize = async (request: FastifyRequest, reply: FastifyReply) => {
    if (!bearerMatches(request.headers.authorization, gateway.token)) {
      return reply.code(401).send(errorBody(request, 'Invalid gateway token', 'unauthorized'));
    }
  };

  // Спека 004, 4.2: регистрация роя и закрытие. Оболочка переводит HTTP в вызов ядра и результат ядра в ответ.
  app.post('/internal/swarms', { onRequest: authorize }, async (request, reply) => {
    const result = await core.registerSwarm(request.body);
    if (result.ok) return reply.code(204).send();
    return reply.code(result.status).send({ error: result.error });
  });

  app.post<{ Params: { swarmId: string } }>(
    '/internal/swarms/:swarmId/close',
    { onRequest: authorize },
    async (request, reply) => {
      const result = await core.closeSwarm(request.params.swarmId);
      if (result.ok) return reply.code(200).send(result.value);
      return reply.code(result.status).send({ error: result.error });
    },
  );

  app.get('/v1/models', { onRequest: authorize }, async () => core.listModels());

  app.post('/v1/chat/completions', { onRequest: authorize }, async (request, reply) => {
    // Клиент ушёл до ответа — отменяем вызов апстрима. Слушаем reply.raw, а не request.raw: на Node 24
    // close у IncomingMessage приходит сразу после чтения тела, до ответа (D-67). Поэтому
    // отмена только если ответ не дописан до конца.
    const abort = new AbortController();
    reply.raw.on('close', () => {
      if (!reply.raw.writableFinished) abort.abort();
    });
    // Ядро получает заголовки и тело как пришли.
    const result: CompleteResult = await core.complete(
      {
        swarmId: single(request.headers[SWARM_ID_HEADER]),
        agentId: single(request.headers[AGENT_ID_HEADER]),
      },
      request.body,
      abort.signal,
    );
    if (result.kind === 'error') {
      return reply.code(result.status).send(gatewayError(result.error.message, result.error.code));
    }
    if (result.kind === 'json') return reply.code(200).send(result.body);
    return writeStream(request, reply, result.chunks, abort.signal);
  });

  // Ошибки разбора тела Fastify: 413 — лимит LLM_GATEWAY_BODY_LIMIT_BYTES, 400 — не JSON.
  // Тело — по 4.2, код — invalid_request: 4.6 кода для 413 не задаёт (D-65).
  // Ошибки 5xx (D-66): текст исключения только в лог, клиенту — фиксированный Internal error. Кода для 500 в
  // GatewayErrorCode нет, взят ближайший — upstream_error (решение приёмки D-66).
  app.setErrorHandler((error: FastifyError, request, reply) => {
    const status = error.statusCode ?? 500;
    if (status >= 500) {
      request.log.error({ err: error }, 'llm gateway internal error');
      return reply.code(500).send(errorBody(request, 'Internal error', 'upstream_error'));
    }
    return reply.code(status).send(errorBody(request, error.message, 'invalid_request'));
  });

  return app;
}

// Спека 002, 4.2: поток SSE. Ответ берётся на себя (hijack), каждый фрагмент уходит клиенту сразу после получения.
// Итерация начинается сразу и идёт до конца или до ошибки: событие и лог пишет finally генератора ядра (D-60).
// Уход клиента: signal отменяет апстрим, ядро бросает UpstreamStreamError (D-62) — тогда писать некуда, ошибку не логируем.
async function writeStream(
  request: FastifyRequest,
  reply: FastifyReply,
  chunks: AsyncIterable<string>,
  signal: AbortSignal,
): Promise<void> {
  reply.hijack();
  try {
    reply.raw.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    reply.raw.flushHeaders();
  } catch (error) {
    // Заголовки не ушли: итерацию всё равно запускаем ниже, иначе поток ядра не дочитается и его finally не сработает (D-60).
    request.log.error({ err: error }, 'llm stream headers failed');
  }
  try {
    for await (const payload of chunks) {
      if (!reply.raw.destroyed) reply.raw.write(`data: ${payload}\n\n`);
    }
  } catch (error) {
    if (!signal.aborted) request.log.error({ err: error }, 'llm stream failed');
  } finally {
    reply.raw.end();
  }
}

// Нет заголовка или он пришёл дважды (массив) — пустая строка: LlmCaller её не пропускает, ядро ответит invalid_caller.
const single = (value: string | string[] | undefined) => (typeof value === 'string' ? value : '');

// Спека 002, 4.2: тело ошибки во всех случаях.
function gatewayError(message: string, code: GatewayErrorCode) {
  return { error: { message, type: 'swag_gateway_error', code } };
}

// Спека 004, 4.2: ошибки /internal/* — { error: { message, code } } без type; /v1/* — как в 002.
function errorBody(
  request: FastifyRequest,
  message: string,
  code: GatewayErrorCode | InternalErrorCode,
) {
  if (request.url.startsWith('/internal/')) return { error: { message, code } };
  return gatewayError(message, code as GatewayErrorCode);
}
