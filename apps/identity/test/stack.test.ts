import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { AccessTokenClaims, AuthMe, AuthSession } from '@swag/contracts';

// Спека 012, AC-012-27 [stack], NFR-012-2, 4.11. Нужны identity и Mailpit из compose:
// STACK_TEST_IDENTITY_URL (например http://127.0.0.1:3003) и STACK_TEST_MAILPIT_URL (http://127.0.0.1:8025).
// Супервизор берётся из IDENTITY_SUPERVISOR_EMAIL и IDENTITY_SUPERVISOR_PASSWORD (как в .env).
// NFR-012-2 перезапускает identity перед каждой серией входов: счётчики лимитов 4.8 живут в памяти процесса.

const identityUrl = process.env['STACK_TEST_IDENTITY_URL'];
const mailpitUrl = process.env['STACK_TEST_MAILPIT_URL'];
const supervisorEmail = process.env['IDENTITY_SUPERVISOR_EMAIL'];
const supervisorPassword = process.env['IDENTITY_SUPERVISOR_PASSWORD'];
const jwtKid = process.env['IDENTITY_JWT_KID'];
const accessTtlS = Number(process.env['IDENTITY_ACCESS_TTL_S']);
const refreshTtlS = Number(process.env['IDENTITY_REFRESH_TTL_S']);
const cookieSecure = process.env['IDENTITY_COOKIE_SECURE'] === 'true';
const PASSWORD = 'stack-password-1';
const ORGANIZATION = 'Стек-тест компания';
const BENCH_SERIES = 10;
const BENCH_SERIES_SIZE = 10;
const HEALTH_TIMEOUT_MS = 60_000;

type SearchResult = { messages: { ID: string }[] | null };
type MailpitMessage = { Text: string };

const percentile = (sorted: number[], p: number): number =>
  sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)] ?? NaN;

async function post(path: string, body: unknown, headers: Record<string, string> = {}) {
  return fetch(`${identityUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

async function mailpitGet<T>(path: string): Promise<T> {
  const r = await fetch(`${mailpitUrl}${path}`);
  if (!r.ok) throw new Error(`Mailpit ${path}: HTTP ${r.status}`);
  return (await r.json()) as T;
}

async function tokenFromMail(email: string): Promise<string> {
  const search = await mailpitGet<SearchResult>(
    `/api/v1/search?query=${encodeURIComponent(`to:"${email}"`)}`,
  );
  const id = search.messages?.[0]?.ID;
  if (!id) throw new Error(`письмо для ${email} не найдено в Mailpit`);
  const message = await mailpitGet<MailpitMessage>(`/api/v1/message/${id}`);
  const token = /token=([A-Za-z0-9_-]+)/.exec(message.Text)?.[1];
  if (!token) throw new Error('в письме нет ссылки с token');
  return token;
}

function refreshSetCookie(response: Response): string {
  const cookie = response.headers.getSetCookie().find((value) => value.startsWith('swag_refresh='));
  if (!cookie) throw new Error('в ответе нет cookie swag_refresh');
  return cookie;
}

function refreshCookie(response: Response): string {
  return refreshSetCookie(response).split(';')[0] ?? '';
}

function expectRefreshCookieAttributes(response: Response): void {
  const attributes = refreshSetCookie(response)
    .split(';')
    .map((attribute) => attribute.trim());
  expect(attributes).toContain('HttpOnly');
  expect(attributes).toContain('SameSite=Strict');
  expect(attributes).toContain('Path=/auth');
  expect(attributes).toContain(`Max-Age=${refreshTtlS}`);
  expect(attributes.includes('Secure')).toBe(cookieSecure);
}

function decodeJwt(token: string): { header: Record<string, unknown>; payload: unknown } {
  const [header = '', payload = ''] = token.split('.');
  return {
    header: JSON.parse(Buffer.from(header, 'base64url').toString()) as Record<string, unknown>,
    payload: JSON.parse(Buffer.from(payload, 'base64url').toString()),
  };
}

async function login(email: string, password: string): Promise<Response> {
  return post('/auth/login', { email, password });
}

function restartIdentity(): void {
  execFileSync('docker', ['compose', 'restart', 'identity'], { stdio: 'ignore' });
}

async function isHealthy(): Promise<boolean> {
  try {
    const response = await fetch(`${identityUrl}/health`);
    await response.text();
    return response.status === 200;
  } catch {
    return false;
  }
}

async function waitForHealth(): Promise<void> {
  const deadline = Date.now() + HEALTH_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (await isHealthy()) return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`identity не ответил на /health за ${HEALTH_TIMEOUT_MS / 1000} с`);
}

describe.skipIf(!identityUrl || !mailpitUrl)('identity [stack]', () => {
  it('AC-012-27: регистрация 202, письмо, подтверждение 201 с cookie, me, выход 204 и стёртая cookie, refresh 401, вход 200 с JWT, повтор подтверждения, вход супервизора', async () => {
    if (!supervisorEmail || !supervisorPassword) {
      throw new Error(
        'AC-012-27: шаг входа супервизора не проверен — задайте IDENTITY_SUPERVISOR_EMAIL и IDENTITY_SUPERVISOR_PASSWORD (в .env)',
      );
    }
    if (!jwtKid || !accessTtlS || !refreshTtlS) {
      throw new Error(
        'AC-012-27: проверка JWT и cookie не выполнена — задайте IDENTITY_JWT_KID, IDENTITY_ACCESS_TTL_S, IDENTITY_REFRESH_TTL_S (в .env)',
      );
    }
    const email = `ac27-${randomUUID()}@example.test`;

    const registration = await post('/auth/registrations', { email });
    expect(registration.status).toBe(202);
    expect(await registration.text()).toBe('');

    const token = await tokenFromMail(email);
    const confirm = await post('/auth/registrations/confirm', {
      token,
      password: PASSWORD,
      organizationName: ORGANIZATION,
    });
    expect(confirm.status).toBe(201);
    expect(confirm.headers.get('cache-control')).toBe('no-store');
    expectRefreshCookieAttributes(confirm);
    const session = AuthSession.parse(await confirm.json());
    expect(session.user.role).toBe('admin');
    expect(session.organization?.name).toBe(ORGANIZATION);
    expect(session.user.orgId).toBe(session.organization?.id);
    const confirmCookie = refreshCookie(confirm);

    const me = await fetch(`${identityUrl}/auth/me`, {
      headers: { authorization: `Bearer ${session.accessToken}` },
    });
    expect(me.status).toBe(200);
    expect(AuthMe.parse(await me.json()).user.id).toBe(session.user.id);

    const logout = await post('/auth/logout', {}, { cookie: confirmCookie });
    expect(logout.status).toBe(204);
    expect(refreshSetCookie(logout)).toContain('Max-Age=0');

    const afterLogout = await post('/auth/refresh', {}, { cookie: confirmCookie });
    expect(afterLogout.status).toBe(401);
    expect(((await afterLogout.json()) as { error: { code: string } }).error.code).toBe(
      'invalid_refresh_token',
    );

    const relogin = await login(email, PASSWORD);
    expect(relogin.status).toBe(200);
    expect(relogin.headers.get('cache-control')).toBe('no-store');
    expectRefreshCookieAttributes(relogin);
    const reloginSession = AuthSession.parse(await relogin.json());
    expect(reloginSession.user.id).toBe(session.user.id);
    expect(reloginSession.expiresIn).toBe(accessTtlS);
    const reloginJwt = decodeJwt(reloginSession.accessToken);
    expect(reloginJwt.header).toMatchObject({ alg: 'EdDSA', kid: jwtKid });
    const claims = AccessTokenClaims.parse(reloginJwt.payload);
    expect(claims).toMatchObject({
      sub: session.user.id,
      org: session.organization?.id,
      role: 'admin',
      iss: 'swag-identity',
      aud: 'swag',
    });
    expect(claims.exp - claims.iat).toBe(accessTtlS);

    const reconfirm = await post('/auth/registrations/confirm', {
      token,
      password: PASSWORD,
      organizationName: ORGANIZATION,
    });
    expect(reconfirm.status).toBe(400);
    expect(((await reconfirm.json()) as { error: { code: string } }).error.code).toBe(
      'invalid_token',
    );

    const supervisor = await login(supervisorEmail, supervisorPassword);
    expect(supervisor.status).toBe(200);
    const supervisorSession = AuthSession.parse(await supervisor.json());
    expect(supervisorSession.organization).toBeNull();
    expect(supervisorSession.user.orgId).toBeNull();
    const supervisorClaims = AccessTokenClaims.parse(
      decodeJwt(supervisorSession.accessToken).payload,
    );
    expect(supervisorClaims).toMatchObject({ org: null, role: 'supervisor' });
  }, 30_000);
});

describe.skipIf(
  !identityUrl || !supervisorEmail || !supervisorPassword || process.env['IDENTITY_BENCH'] !== '1',
)('identity бенч входа [stack]', () => {
  it('NFR-012-2: 10 серий по 10 последовательных входов после перезапуска identity — все 200, p95 меньше 600 мс', async () => {
    const times: number[] = [];
    const statuses: number[] = [];
    for (let series = 0; series < BENCH_SERIES; series += 1) {
      restartIdentity();
      await waitForHealth();
      for (let i = 0; i < BENCH_SERIES_SIZE; i += 1) {
        const started = performance.now();
        const response = await login(supervisorEmail ?? '', supervisorPassword ?? '');
        times.push(performance.now() - started);
        statuses.push(response.status);
        await response.text();
      }
    }
    restartIdentity();
    await waitForHealth();

    const sorted = [...times].sort((a, b) => a - b);
    const p50 = percentile(sorted, 50);
    const p95 = percentile(sorted, 95);
    const max = sorted[sorted.length - 1] ?? NaN;
    console.log(
      `NFR-012-2 POST /auth/login, ${BENCH_SERIES} серий по ${BENCH_SERIES_SIZE} входов: статусы ${[...new Set(statuses)].join(',')}, p50=${p50.toFixed(1)} мс, p95=${p95.toFixed(1)} мс, max=${max.toFixed(1)} мс`,
    );
    expect([...new Set(statuses)]).toEqual([200]);
    expect(p95).toBeLessThan(600);
  }, 600_000);
});
