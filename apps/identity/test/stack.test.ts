import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { AuthMe, AuthSession } from '@swag/contracts';

// Спека 012, AC-012-27 [stack], NFR-012-2, 4.11. Нужны identity и Mailpit из compose:
// STACK_TEST_IDENTITY_URL (например http://127.0.0.1:3003) и STACK_TEST_MAILPIT_URL (http://127.0.0.1:8025).
// Супервизор берётся из IDENTITY_SUPERVISOR_EMAIL и IDENTITY_SUPERVISOR_PASSWORD (как в .env).

const identityUrl = process.env['STACK_TEST_IDENTITY_URL'];
const mailpitUrl = process.env['STACK_TEST_MAILPIT_URL'];
const supervisorEmail = process.env['IDENTITY_SUPERVISOR_EMAIL'];
const supervisorPassword = process.env['IDENTITY_SUPERVISOR_PASSWORD'];
const PASSWORD = 'stack-password-1';
const ORGANIZATION = 'Стек-тест компания';
const BENCH_RUNS = 100;

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
  const token = /token=([A-Za-z0-9_-]{43})/.exec(message.Text)?.[1];
  if (!token) throw new Error('в письме нет ссылки с token');
  return token;
}

function refreshCookie(response: Response): string {
  const cookie = response.headers.getSetCookie().find((value) => value.startsWith('swag_refresh='));
  const value = cookie?.slice('swag_refresh='.length).split(';')[0];
  if (!value) throw new Error('в ответе нет cookie swag_refresh');
  return `swag_refresh=${value}`;
}

async function login(email: string, password: string): Promise<Response> {
  return post('/auth/login', { email, password });
}

describe.skipIf(!identityUrl || !mailpitUrl)('identity [stack]', () => {
  it('AC-012-27: регистрация, письмо, подтверждение, me, выход, вход, повтор подтверждения, вход супервизора', async () => {
    const email = `ac27-${randomUUID()}@example.test`;

    const registration = await post('/auth/registrations', { email });
    expect(registration.status).toBe(202);

    const token = await tokenFromMail(email);
    const confirm = await post('/auth/registrations/confirm', {
      token,
      password: PASSWORD,
      organizationName: ORGANIZATION,
    });
    expect(confirm.status).toBe(201);
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

    const relogin = await login(email, PASSWORD);
    expect(relogin.status).toBe(200);
    expect(AuthSession.parse(await relogin.json()).user.id).toBe(session.user.id);

    const reconfirm = await post('/auth/registrations/confirm', {
      token,
      password: PASSWORD,
      organizationName: ORGANIZATION,
    });
    expect(reconfirm.status).toBe(400);
    expect(((await reconfirm.json()) as { error: { code: string } }).error.code).toBe(
      'invalid_token',
    );

    if (!supervisorEmail || !supervisorPassword) {
      throw new Error(
        'AC-012-27: шаг входа супервизора не проверен — задайте IDENTITY_SUPERVISOR_EMAIL и IDENTITY_SUPERVISOR_PASSWORD (в .env)',
      );
    }
    const supervisor = await login(supervisorEmail, supervisorPassword);
    expect(supervisor.status).toBe(200);
    const supervisorSession = AuthSession.parse(await supervisor.json());
    expect(supervisorSession.organization).toBeNull();
    expect(supervisorSession.user.orgId).toBeNull();
  }, 30_000);
});

describe.skipIf(
  !identityUrl || !supervisorEmail || !supervisorPassword || process.env['IDENTITY_BENCH'] !== '1',
)('identity бенч входа [stack]', () => {
  it('NFR-012-2: 100 последовательных входов — все 200, p95 меньше 600 мс', async () => {
    const times: number[] = [];
    const statuses: number[] = [];
    for (let i = 0; i < BENCH_RUNS; i += 1) {
      const started = performance.now();
      const response = await login(supervisorEmail ?? '', supervisorPassword ?? '');
      times.push(performance.now() - started);
      statuses.push(response.status);
      await response.text();
    }
    const sorted = [...times].sort((a, b) => a - b);
    const p50 = percentile(sorted, 50);
    const p95 = percentile(sorted, 95);
    console.log(
      `NFR-012-2 POST /auth/login, ${BENCH_RUNS} последовательных: статусы ${[...new Set(statuses)].join(',')}, p50=${p50.toFixed(1)} мс, p95=${p95.toFixed(1)} мс`,
    );
    expect([...new Set(statuses)]).toEqual([200]);
    expect(p95).toBeLessThan(600);
  }, 120_000);
});
