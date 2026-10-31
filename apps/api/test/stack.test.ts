import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { describe, expect, it } from 'vitest';
import { AuthSession, BalanceView, OrganizationList } from '@swag/contracts';
import { onHost } from '../../../scripts/host-url.ts';

// Спека 024, AC-024-24 [stack], NFR-024-1, шаги S-1 1, 7–10 на уровне HTTP.
// Нужен поднятый контур из compose: STACK_TEST_API_URL (например http://127.0.0.1:3000),
// STACK_TEST_IDENTITY_URL и STACK_TEST_MAILPIT_URL. Супервизор — IDENTITY_SUPERVISOR_EMAIL и
// IDENTITY_SUPERVISOR_PASSWORD (как в .env). Задержка отзыва — API_REVOCATION_POLL_MS (как в .env).
// Без STACK_TEST_API_URL тест пропускается.

const PASSWORD = 'stack-password-1';
const POLL_STEP_MS = 100;
const REVOCATION_SLACK_MS = 1000;
// D-122: новый вход после отзыва — не раньше чем через секунду (iat в секундах).
const REENTRY_WAIT_MS = 1000;
const SWARM_BUDGET_MICRO_USD = 1_000_000;
const SWARM_WAIT_MS = 240_000;
const SETTLE_POLL_MS = 500;
const TERMINAL_STATUSES = ['completed', 'stopped', 'failed'];

interface Stack {
  api: string;
  identity: string;
  mailpit: string;
  supervisorEmail: string;
  supervisorPassword: string;
}

interface CallOptions {
  method?: string;
  token?: string;
  body?: unknown;
}

function requireStack(): Stack {
  const api = process.env['STACK_TEST_API_URL'];
  const identity = process.env['STACK_TEST_IDENTITY_URL'];
  const mailpit = process.env['STACK_TEST_MAILPIT_URL'];
  if (!api || !identity || !mailpit) {
    throw new Error(
      'AC-024-24: нужны STACK_TEST_API_URL, STACK_TEST_IDENTITY_URL и STACK_TEST_MAILPIT_URL (в .env)',
    );
  }
  const supervisorEmail = process.env['IDENTITY_SUPERVISOR_EMAIL'];
  const supervisorPassword = process.env['IDENTITY_SUPERVISOR_PASSWORD'];
  if (!supervisorEmail || !supervisorPassword) {
    throw new Error(
      'AC-024-24: шаг входа супервизора не проверен — задайте IDENTITY_SUPERVISOR_EMAIL и IDENTITY_SUPERVISOR_PASSWORD (в .env)',
    );
  }
  return { api, identity, mailpit, supervisorEmail, supervisorPassword };
}

async function call(base: string, path: string, options: CallOptions = {}): Promise<Response> {
  const { method = 'GET', token, body } = options;
  const headers: Record<string, string> = {};
  if (token) headers['authorization'] = `Bearer ${token}`;
  const init: RequestInit = { method, headers };
  if (body !== undefined) {
    headers['content-type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  return fetch(`${base}${path}`, init);
}

async function tokenFromMail(mailpit: string, email: string): Promise<string> {
  const search = (await (
    await fetch(`${mailpit}/api/v1/search?query=${encodeURIComponent(`to:"${email}"`)}`)
  ).json()) as { messages: { ID: string }[] | null };
  const id = search.messages?.[0]?.ID;
  if (!id) throw new Error(`письмо для ${email} не найдено в Mailpit`);
  const message = (await (await fetch(`${mailpit}/api/v1/message/${id}`)).json()) as {
    Text: string;
  };
  const token = /token=([A-Za-z0-9_-]+)/.exec(message.Text)?.[1];
  if (!token) throw new Error('в письме нет ссылки с token');
  return token;
}

async function register(
  stack: Stack,
  email: string,
  organizationName: string,
): Promise<AuthSession> {
  const registration = await call(stack.identity, '/auth/registrations', {
    method: 'POST',
    body: { email },
  });
  expect(registration.status).toBe(202);
  await registration.text();
  const token = await tokenFromMail(stack.mailpit, email);
  const confirm = await call(stack.identity, '/auth/registrations/confirm', {
    method: 'POST',
    body: { token, password: PASSWORD, organizationName },
  });
  expect(confirm.status).toBe(201);
  return AuthSession.parse(await confirm.json());
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function topup(stack: Stack, token: string, orgId: string, amountMicroUsd: number) {
  const response = await call(stack.api, `/organizations/${orgId}/balance/topups`, {
    method: 'POST',
    token,
    body: { amountMicroUsd, comment: null },
  });
  expect(response.status).toBe(201);
  await response.text();
}

async function balanceOf(stack: Stack, token: string, orgId: string): Promise<BalanceView> {
  const response = await call(stack.api, `/organizations/${orgId}/balance`, { token });
  expect(response.status).toBe(200);
  return BalanceView.parse(await response.json());
}

async function swarmStatus(
  stack: Stack,
  token: string,
  swarmId: string,
): Promise<{ status: string; spentMicroUsd: number }> {
  const response = await call(stack.api, `/swarms/${swarmId}`, { token });
  expect(response.status).toBe(200);
  return (await response.json()) as { status: string; spentMicroUsd: number };
}

async function waitFor<T>(read: () => Promise<T>, done: (value: T) => boolean): Promise<T> {
  const deadline = performance.now() + SWARM_WAIT_MS;
  for (;;) {
    const value = await read();
    if (done(value)) return value;
    if (performance.now() > deadline) throw new Error('AC-013-24: таймаут ожидания');
    await sleep(SETTLE_POLL_MS);
  }
}

// Ledger пишет gateway в Postgres той же базы, что и api; имя postgres видно только внутри compose.
async function ledgerSum(swarmId: string): Promise<number> {
  const url = process.env['DATABASE_URL'];
  if (!url) throw new Error('AC-013-24: нужен DATABASE_URL (в .env)');
  const db = new pg.Client({
    connectionString: new URL(url).hostname === 'postgres' ? onHost(url) : url,
  });
  await db.connect();
  try {
    const result = await db.query<{ sum: string }>(
      'select coalesce(sum(amount_micro_usd), 0)::text as sum from ledger_entries where swarm_id = $1',
      [swarmId],
    );
    return Number(result.rows[0]?.sum);
  } finally {
    await db.end();
  }
}

describe.skipIf(!process.env['STACK_TEST_API_URL'])('api [stack]', () => {
  it('AC-024-24: две компании, приглашённый пользователь видит свой рой, чужая организация получает 404, супервизор видит обе организации и рой, блокировка даёт 401 в api и 403 при входе', async () => {
    const stack = requireStack();
    const tag = randomUUID();
    const orgAName = `Стек-тест 024 A ${tag}`;
    const orgBName = `Стек-тест 024 B ${tag}`;
    const userEmail = `stack024-user-${tag}@example.test`;

    const anonymous = await call(stack.api, '/swarms');
    expect(anonymous.status).toBe(401);
    expect(((await anonymous.json()) as { error: { code: string } }).error.code).toBe(
      'unauthorized',
    );

    const adminA = await register(stack, `stack024-admin-a-${tag}@example.test`, orgAName);
    const adminB = await register(stack, `stack024-admin-b-${tag}@example.test`, orgBName);
    expect(adminA.user.role).toBe('admin');
    expect(adminB.user.role).toBe('admin');
    await topup(stack, adminA.accessToken, adminA.organization?.id ?? '', SWARM_BUDGET_MICRO_USD);

    const invitation = await call(stack.identity, '/auth/invitations', {
      method: 'POST',
      token: adminA.accessToken,
      body: { email: userEmail, role: 'user' },
    });
    expect(invitation.status).toBe(202);
    await invitation.text();
    const inviteToken = await tokenFromMail(stack.mailpit, userEmail);
    const accept = await call(stack.identity, '/auth/invitations/accept', {
      method: 'POST',
      body: { token: inviteToken, password: PASSWORD },
    });
    expect(accept.status).toBe(201);
    const user = AuthSession.parse(await accept.json());
    expect(user.user.role).toBe('user');
    expect(user.organization?.id).toBe(adminA.organization?.id);

    const userLogin = await call(stack.identity, '/auth/login', {
      method: 'POST',
      body: { email: userEmail, password: PASSWORD },
    });
    expect(userLogin.status).toBe(200);
    expect(AuthSession.parse(await userLogin.json()).user.role).toBe('user');

    let swarmId: string | undefined;
    let supervisorToken: string | undefined;
    try {
      const created = await call(stack.api, '/swarms', {
        method: 'POST',
        token: user.accessToken,
        body: {
          task: 'стек-тест спеки 024',
          budgetMicroUsd: SWARM_BUDGET_MICRO_USD,
          agents: [{ name: 'agent-1', role: 'Ответь одним словом', model: 'chat-small' }],
        },
      });
      expect(created.status).toBe(201);
      swarmId = ((await created.json()) as { id: string }).id;

      const ownView = await call(stack.api, `/swarms/${swarmId}`, { token: user.accessToken });
      expect(ownView.status).toBe(200);
      await ownView.text();
      const ownList = (await (
        await call(stack.api, '/swarms', { token: user.accessToken })
      ).json()) as { id: string }[];
      expect(ownList.map((swarm) => swarm.id)).toEqual([swarmId]);

      const foreignView = await call(stack.api, `/swarms/${swarmId}`, {
        token: adminB.accessToken,
      });
      expect(foreignView.status).toBe(404);
      await foreignView.text();

      const supervisorLogin = await call(stack.identity, '/auth/login', {
        method: 'POST',
        body: { email: stack.supervisorEmail, password: stack.supervisorPassword },
      });
      expect(supervisorLogin.status).toBe(200);
      const supervisor = AuthSession.parse(await supervisorLogin.json());
      supervisorToken = supervisor.accessToken;

      const organizations = OrganizationList.parse(
        await (
          await call(stack.identity, '/auth/organizations', { token: supervisor.accessToken })
        ).json(),
      );
      expect(organizations.organizations.map((org) => org.name)).toEqual(
        expect.arrayContaining([orgAName, orgBName]),
      );
      const supervisorSwarms = (await (
        await call(stack.api, '/swarms', { token: supervisor.accessToken })
      ).json()) as { id: string }[];
      expect(supervisorSwarms.map((swarm) => swarm.id)).toContain(swarmId);

      const block = await call(stack.identity, `/auth/users/${user.user.id}`, {
        method: 'PATCH',
        token: adminA.accessToken,
        body: { blocked: true },
      });
      expect(block.status).toBe(200);
      await block.text();

      const limitMs = Number(process.env['API_REVOCATION_POLL_MS'] ?? 5000) + REVOCATION_SLACK_MS;
      const blockedAt = performance.now();
      let status = 0;
      while (performance.now() - blockedAt <= limitMs) {
        const probe = await call(stack.api, `/swarms/${swarmId}`, { token: user.accessToken });
        status = probe.status;
        await probe.text();
        if (status === 401) break;
        await sleep(POLL_STEP_MS);
      }
      const revokeMs = performance.now() - blockedAt;
      console.log('NFR-024-1, мс:', Math.round(revokeMs));
      expect(status).toBe(401);
      expect(revokeMs).toBeLessThanOrEqual(limitMs);

      await sleep(REENTRY_WAIT_MS);
      const blockedLogin = await call(stack.identity, '/auth/login', {
        method: 'POST',
        body: { email: userEmail, password: PASSWORD },
      });
      expect(blockedLogin.status).toBe(403);
      expect(((await blockedLogin.json()) as { error: { code: string } }).error.code).toBe(
        'user_blocked',
      );
    } finally {
      if (swarmId) {
        // Уборка: рой мог уже остановиться при блокировке, поэтому ответ не проверяем.
        await call(stack.api, `/swarms/${swarmId}/stop`, {
          method: 'POST',
          token: supervisorToken ?? user.accessToken,
        })
          .then((response) => response.text())
          .catch(() => undefined);
      }
    }
  }, 180_000);

  it('AC-013-24: пополнение $1, рой на $0.50 держит резерв, рой на $0.60 получает 402, после завершения первого held = 0 и баланс уменьшился на сумму ledger роя', async () => {
    const stack = requireStack();
    const tag = randomUUID();
    const admin = await register(
      stack,
      `stack013-admin-${tag}@example.test`,
      `Стек-тест 013 ${tag}`,
    );
    const orgId = admin.organization?.id ?? '';
    expect(admin.user.role).toBe('admin');

    await topup(stack, admin.accessToken, orgId, 1_000_000);
    expect((await balanceOf(stack, admin.accessToken, orgId)).balanceMicroUsd).toBe(1_000_000);

    const swarmBody = (budgetMicroUsd: number) => ({
      task: 'стек-тест спеки 013',
      budgetMicroUsd,
      agents: [{ name: 'agent-1', role: 'Ответь одним словом', model: 'chat-small' }],
    });
    const first = await call(stack.api, '/swarms', {
      method: 'POST',
      token: admin.accessToken,
      body: swarmBody(500_000),
    });
    expect(first.status).toBe(201);
    const firstId = ((await first.json()) as { id: string }).id;

    try {
      const reserved = await balanceOf(stack, admin.accessToken, orgId);
      expect(reserved.heldMicroUsd).toBe(500_000);

      const second = await call(stack.api, '/swarms', {
        method: 'POST',
        token: admin.accessToken,
        body: swarmBody(600_000),
      });
      expect(second.status).toBe(402);
      expect(((await second.json()) as { error: { code: string } }).error.code).toBe(
        'insufficient_balance',
      );

      const finished = await waitFor(
        () => swarmStatus(stack, admin.accessToken, firstId),
        (view) => TERMINAL_STATUSES.includes(view.status),
      );
      expect(finished.status).toBe('completed');

      const settled = await waitFor(
        () => balanceOf(stack, admin.accessToken, orgId),
        (view) => view.heldMicroUsd === 0,
      );
      const spent = await ledgerSum(firstId);
      expect(settled.balanceMicroUsd).toBe(1_000_000 - spent);
      expect(settled.availableMicroUsd).toBe(1_000_000 - spent);
    } finally {
      // Уборка: рой мог уже завершиться, поэтому ответ не проверяем.
      await call(stack.api, `/swarms/${firstId}/stop`, {
        method: 'POST',
        token: admin.accessToken,
      })
        .then((response) => response.text())
        .catch(() => undefined);
    }
  }, 300_000);
});
