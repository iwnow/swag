import { timingSafeEqual } from 'node:crypto';
import { AGENT_ID_HEADER, SWARM_ID_HEADER, type GatewayErrorCode } from '@swag/contracts';
import type { CompleteResult, LlmGatewayCore } from '@swag/llm-gateway-core';
import Fastify, {
  type FastifyError,
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
  type FastifyServerOptions,
} from 'fastify';

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
  const authorize = async (request: FastifyRequest, reply: FastifyReply) => {
    const header = request.headers.authorization ?? '';
    const presented = header.startsWith('Bearer ') ? header.slice('Bearer '.length) : '';
    if (!tokenMatches(presented, gateway.token)) {
      return reply.code(401).send(gatewayError('Invalid gateway token', 'unauthorized'));
    }
  };

  app.get('/v1/models', { onRequest: authorize }, async () => core.listModels());

  app.post('/v1/chat/completions', { onRequest: authorize }, async (request, reply) => {
    // Ядро получает заголовки и тело как пришли. Сигнал пока не отменяется: AbortController по close — T-22.
    const result: CompleteResult = await core.complete(
      {
        swarmId: single(request.headers[SWARM_ID_HEADER]),
        agentId: single(request.headers[AGENT_ID_HEADER]),
      },
      request.body,
      new AbortController().signal,
    );
    if (result.kind === 'error') {
      return reply.code(result.status).send(gatewayError(result.error.message, result.error.code));
    }
    // Запись kind 'json' — T-22, kind 'stream' — T-23. До них маршрут отвечает 501 без тела.
    return reply.code(501).send();
  });

  // Ошибки разбора тела Fastify: 413 — лимит LLM_GATEWAY_BODY_LIMIT_BYTES, 400 — не JSON.
  // Тело — по 4.2, код — invalid_request: 4.6 кода для 413 не задаёт (D-65). Ошибки 5xx — штатный ответ Fastify.
  app.setErrorHandler((error: FastifyError, _request, reply) => {
    const status = error.statusCode ?? 500;
    if (status >= 500) throw error;
    return reply.code(status).send(gatewayError(error.message, 'invalid_request'));
  });

  return app;
}

// Спека 002, 4.2: сравнение через timingSafeEqual; разная длина — отказ сразу, без сравнения.
function tokenMatches(presented: string, expected: string): boolean {
  const given = Buffer.from(presented);
  const wanted = Buffer.from(expected);
  return given.length === wanted.length && timingSafeEqual(given, wanted);
}

// Нет заголовка или он пришёл дважды (массив) — пустая строка: LlmCaller её не пропускает, ядро ответит invalid_caller.
const single = (value: string | string[] | undefined) => (typeof value === 'string' ? value : '');

// Спека 002, 4.2: тело ошибки во всех случаях.
function gatewayError(message: string, code: GatewayErrorCode) {
  return { error: { message, type: 'swag_gateway_error', code } };
}
