import cookie from '@fastify/cookie';
import type { AuthErrorCode } from '@swag/contracts';
import { bearerMatches } from '@swag/helpers/server';
import type { IdentityCore, IdentityError, IssuedSession } from '@swag/identity-core';
import Fastify, {
  type FastifyError,
  type FastifyInstance,
  type FastifyReply,
  type FastifyServerOptions,
} from 'fastify';

// Спека 012, 4.4 и 4.5: оболочка identity. Решений здесь нет — только вход и выход ядра, коды ошибок в статусы.
const REFRESH_COOKIE = 'swag_refresh';
const REFRESH_PATH = '/auth';

export interface AppSettings {
  cookieSecure: boolean; // IDENTITY_COOKIE_SECURE
  refreshTtlS: number; // IDENTITY_REFRESH_TTL_S, Max-Age cookie
  bodyLimit: number; // IDENTITY_BODY_LIMIT_BYTES
  internalToken: string; // IDENTITY_INTERNAL_TOKEN, спека 024, 4.7
}

const PURGE_INTERVAL_MS = 60 * 60 * 1000; // спека 024, 4.8: уборка раз в час

const STATUS: Record<AuthErrorCode, number> = {
  validation_error: 400,
  invalid_token: 400,
  email_taken: 409,
  invalid_credentials: 401,
  invalid_refresh_token: 401,
  unauthorized: 401,
  rate_limited: 429,
  mail_unavailable: 503,
  internal_error: 500,
  forbidden: 403,
  not_found: 404,
  user_blocked: 403,
};

const bearer = (header: string | undefined): string | undefined =>
  header?.startsWith('Bearer ') ? header.slice('Bearer '.length) : undefined;

export async function buildApp(
  core: IdentityCore,
  settings: AppSettings,
  options: FastifyServerOptions = {},
): Promise<FastifyInstance> {
  const app = Fastify({ ...options, bodyLimit: settings.bodyLimit });
  await app.register(cookie);

  const refreshCookie = {
    httpOnly: true,
    sameSite: 'strict',
    path: REFRESH_PATH,
    secure: settings.cookieSecure,
  } as const;
  const setRefresh = (reply: FastifyReply, token: string) =>
    reply.setCookie(REFRESH_COOKIE, token, { ...refreshCookie, maxAge: settings.refreshTtlS });
  const clearRefresh = (reply: FastifyReply) =>
    reply.setCookie(REFRESH_COOKIE, '', { ...refreshCookie, maxAge: 0 });

  const fail = (reply: FastifyReply, error: IdentityError) =>
    reply.code(STATUS[error.code]).send({ error });

  const issued = (reply: FastifyReply, value: IssuedSession, status: number) => {
    setRefresh(reply, value.refreshToken);
    return reply.code(status).header('Cache-Control', 'no-store').send(value.session);
  };

  // healthcheck compose опрашивает каждые 2 с — в лог только предупреждения.
  app.get('/health', { logLevel: 'warn' }, async () => ({ status: 'ok', ...core.info() }));

  app.post('/auth/registrations', async (request, reply) => {
    const result = await core.requestRegistration(request.body, { ip: request.ip });
    if (!result.ok) return fail(reply, result.error);
    return reply.code(202).send();
  });

  app.post('/auth/registrations/confirm', async (request, reply) => {
    const result = await core.confirmRegistration(request.body, { ip: request.ip });
    if (!result.ok) return fail(reply, result.error);
    return issued(reply, result.value, 201);
  });

  app.post('/auth/login', async (request, reply) => {
    const result = await core.login(request.body, { ip: request.ip });
    if (!result.ok) return fail(reply, result.error);
    return issued(reply, result.value, 200);
  });

  app.post('/auth/refresh', async (request, reply) => {
    const result = await core.refresh(request.cookies[REFRESH_COOKIE]);
    if (!result.ok) {
      if (result.error.code === 'invalid_refresh_token') clearRefresh(reply);
      return fail(reply, result.error);
    }
    setRefresh(reply, result.value.refreshToken);
    return reply.code(200).header('Cache-Control', 'no-store').send(result.value.refreshed);
  });

  app.post('/auth/logout', async (request, reply) => {
    const result = await core.logout(request.cookies[REFRESH_COOKIE]);
    clearRefresh(reply);
    if (!result.ok) return fail(reply, result.error);
    return reply.code(204).send();
  });

  app.get('/auth/me', async (request, reply) => {
    const result = await core.me(bearer(request.headers.authorization));
    if (!result.ok) return fail(reply, result.error);
    return reply.code(200).send(result.value);
  });

  app.get('/auth/users', async (request, reply) => {
    const { orgId } = request.query as { orgId?: unknown };
    const result = await core.listUsers(
      bearer(request.headers.authorization),
      typeof orgId === 'string' ? { orgId } : {},
    );
    if (!result.ok) return fail(reply, result.error);
    return reply.code(200).send(result.value);
  });

  app.post('/auth/invitations', async (request, reply) => {
    const result = await core.inviteUser(bearer(request.headers.authorization), request.body);
    if (!result.ok) return fail(reply, result.error);
    return reply.code(202).send();
  });

  app.post('/auth/invitations/accept', async (request, reply) => {
    const result = await core.acceptInvitation(request.body, { ip: request.ip });
    if (!result.ok) return fail(reply, result.error);
    return issued(reply, result.value, 201);
  });

  app.patch('/auth/users/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const result = await core.updateUser(bearer(request.headers.authorization), id, request.body);
    if (!result.ok) return fail(reply, result.error);
    return reply.code(200).send(result.value);
  });

  app.get('/auth/organizations', async (request, reply) => {
    const result = await core.listOrganizations(bearer(request.headers.authorization));
    if (!result.ok) return fail(reply, result.error);
    return reply.code(200).send(result.value);
  });

  // Спека 024, 4.7: только для identity-клиентов с IDENTITY_INTERNAL_TOKEN; ошибка в общем формате { error: { code, message } }.
  app.get('/internal/token-revocations', async (request, reply) => {
    if (!bearerMatches(request.headers.authorization, settings.internalToken)) {
      return fail(reply, { code: 'unauthorized', message: 'unauthorized' });
    }
    return reply.code(200).send(await core.tokenRevocations());
  });

  // Спека 013, 4.8: проверка организации для api; тот же внутренний токен. Ошибка ядра — 500 через errorHandler.
  app.get('/internal/organizations/:orgId', async (request, reply) => {
    if (!bearerMatches(request.headers.authorization, settings.internalToken)) {
      return fail(reply, { code: 'unauthorized', message: 'unauthorized' });
    }
    const { orgId } = request.params as { orgId: string };
    if (!(await core.organizationExists(orgId))) {
      return fail(reply, { code: 'not_found', message: 'Organization not found' });
    }
    return reply.code(204).send();
  });

  // Спека 024, 4.8: уборка при старте и раз в час; ошибка — warn без текста ошибки (N-23).
  let purgeTimer: ReturnType<typeof setInterval> | undefined;
  const purge = () => core.purgeExpired().catch(() => app.log.warn('identity_purge_failed'));
  app.addHook('onReady', async () => {
    await purge();
    purgeTimer = setInterval(() => void purge(), PURGE_INTERVAL_MS);
    purgeTimer.unref();
  });
  app.addHook('onClose', async () => {
    clearInterval(purgeTimer);
  });

  // Ошибки формата запроса Fastify (413, неверный JSON, неподдерживаемый тип) — validation_error с фиксированным текстом:
  // текст ошибки парсера может содержать фрагмент тела, а тело в ответах и логах не нужно.
  app.setErrorHandler((error: FastifyError, _request, reply) => {
    const status = error.statusCode ?? 500;
    if (status >= 500) {
      app.log.error({ err: error }, 'request failed');
      void reply.code(500).send({ error: { code: 'internal_error', message: 'internal error' } });
      return;
    }
    void reply
      .code(status)
      .send({ error: { code: 'validation_error', message: 'invalid request' } });
  });

  return app;
}
