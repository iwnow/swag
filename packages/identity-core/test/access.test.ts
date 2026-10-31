import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  ADMIN_EMAIL,
  ADMIN_PASSWORD,
  HOUR_MS,
  NOW,
  createTestEnv,
  seedAdmin,
  type TestEnv,
} from './fakes.ts';

// Спека 024, T-7: блокировка, отзыв токенов, listUsers, listOrganizations (ядро).

const meta = { ip: '10.0.0.7' };
const PASSWORD = ADMIN_PASSWORD;
const SUPERVISOR_EMAIL = 'supervisor@example.test';
const SUPERVISOR_PASSWORD = 'supervisor password 1';

type Seeded = { userId: string; orgId: string };

// Организация с администратором, как после confirmRegistration (через хранилище).
async function seedOrganization(env: TestEnv, email: string, orgName: string): Promise<Seeded> {
  const userId = randomUUID();
  const orgId = randomUUID();
  const tokenHash = `seed-org-${randomUUID()}`;
  await env.store.addConfirmation({ tokenHash, email, expiresAt: NOW + HOUR_MS, createdAt: NOW });
  await env.store.confirmRegistration({
    tokenHash,
    now: NOW,
    org: { id: orgId, name: orgName, createdAt: NOW },
    user: {
      id: userId,
      passwordHash: `fake-hash:${PASSWORD}`,
      role: 'admin',
      orgId,
      createdAt: NOW,
      blockedAt: null,
      tokensValidAfter: null,
    },
  });
  return { userId, orgId };
}

async function addMember(env: TestEnv, email: string, orgId: string): Promise<string> {
  const id = randomUUID();
  await env.store.createUser({
    id,
    email,
    passwordHash: `fake-hash:${PASSWORD}`,
    role: 'user',
    orgId,
    createdAt: NOW,
    blockedAt: null,
    tokensValidAfter: null,
  });
  return id;
}

async function loginAs(env: TestEnv, email: string, password = PASSWORD) {
  const result = await env.core.login({ email, password }, meta);
  if (!result.ok) throw new Error(`вход ${email}: ${result.error.code}`);
  return result.value;
}

describe('identity-core — блокировка и отзыв (спека 024, T-7)', () => {
  it('AC-024-6: заблокированный с верным паролем — user_blocked и warn login_blocked; с неверным — invalid_credentials; после разблокировки вход проходит', async () => {
    const env = createTestEnv();
    const { userId } = await seedAdmin(env);
    await env.store.updateUser({ id: userId, blockedAt: NOW });

    const blocked = await env.core.login({ email: ADMIN_EMAIL, password: PASSWORD }, meta);
    expect(blocked).toMatchObject({ ok: false, error: { code: 'user_blocked' } });
    expect(env.entries.filter((e) => e.msg === 'login_blocked')).toEqual([
      { level: 'warn', msg: 'login_blocked', ctx: { userId } },
    ]);

    const wrong = await env.core.login({ email: ADMIN_EMAIL, password: 'wrong password 1' }, meta);
    expect(wrong).toMatchObject({ ok: false, error: { code: 'invalid_credentials' } });

    await env.store.updateUser({ id: userId, blockedAt: null });
    expect(await env.core.login({ email: ADMIN_EMAIL, password: PASSWORD }, meta)).toMatchObject({
      ok: true,
    });
  });

  it('AC-024-7: блокировка с revokeAt — me, listUsers → unauthorized, refresh → invalid_refresh_token', async () => {
    const env = createTestEnv();
    const { userId } = await seedAdmin(env);
    const { session, refreshToken } = await loginAs(env, ADMIN_EMAIL);

    await env.store.updateUser({ id: userId, blockedAt: NOW, revokeAt: NOW });

    expect(await env.core.me(session.accessToken)).toMatchObject({
      ok: false,
      error: { code: 'unauthorized' },
    });
    expect(await env.core.listUsers(session.accessToken, {})).toMatchObject({
      ok: false,
      error: { code: 'unauthorized' },
    });
    expect(await env.core.refresh(refreshToken)).toMatchObject({
      ok: false,
      error: { code: 'invalid_refresh_token' },
    });
  });

  it('AC-024-7: блокировка без отзыва сессий — токен доступа → unauthorized, refresh → invalid_refresh_token', async () => {
    const env = createTestEnv();
    const { userId } = await seedAdmin(env);
    const { session, refreshToken } = await loginAs(env, ADMIN_EMAIL);

    await env.store.updateUser({ id: userId, blockedAt: NOW });

    expect(await env.core.me(session.accessToken)).toMatchObject({
      ok: false,
      error: { code: 'unauthorized' },
    });
    expect(await env.core.refresh(refreshToken)).toMatchObject({
      ok: false,
      error: { code: 'invalid_refresh_token' },
    });
  });

  it('AC-024-7: смена роли с revokeAt — старый токен и сессия не работают; новый вход даёт новую роль и токен принимается', async () => {
    const env = createTestEnv();
    const { userId } = await seedAdmin(env);
    const old = await loginAs(env, ADMIN_EMAIL);
    expect(await env.core.listUsers(old.session.accessToken, {})).toMatchObject({ ok: true });

    // iat в секундах: токен, выпущенный до revokeAt, имеет iat*1000 < revokeAt.
    env.clock.advance(1000);
    const revokeAt = env.clock.now();
    await env.store.updateUser({ id: userId, role: 'user', revokeAt });

    expect(await env.core.me(old.session.accessToken)).toMatchObject({
      ok: false,
      error: { code: 'unauthorized' },
    });
    expect(await env.core.listUsers(old.session.accessToken, {})).toMatchObject({
      ok: false,
      error: { code: 'unauthorized' },
    });
    expect(await env.core.refresh(old.refreshToken)).toMatchObject({
      ok: false,
      error: { code: 'invalid_refresh_token' },
    });

    // Новый токен выпущен в момент revokeAt: iat*1000 >= revokeAt, поэтому принимается.
    const fresh = await loginAs(env, ADMIN_EMAIL);
    expect(fresh.session.user.role).toBe('user');
    expect(await env.core.me(fresh.session.accessToken)).toMatchObject({
      ok: true,
      value: { user: { role: 'user' } },
    });
    expect(await env.core.listUsers(fresh.session.accessToken, {})).toMatchObject({
      ok: false,
      error: { code: 'forbidden' },
    });
  });

  it('роль из хранилища, а не из токена: токен с ролью admin у пользователя, который в хранилище user — forbidden', async () => {
    const env = createTestEnv();
    const { orgId } = await seedAdmin(env);
    const memberId = await addMember(env, 'member@example.test', orgId);
    const iat = NOW / 1000;
    const forged = await env.deps.signer.sign({
      sub: memberId,
      org: orgId,
      role: 'admin',
      iss: 'swag-identity',
      aud: 'swag',
      iat,
      exp: iat + 900,
    });

    expect(await env.core.listUsers(forged, {})).toMatchObject({
      ok: false,
      error: { code: 'forbidden' },
    });
    expect(await env.core.me(forged)).toMatchObject({
      ok: true,
      value: { user: { id: memberId, role: 'user' } },
    });
  });
});

describe('identity-core — listUsers и listOrganizations (спека 024, T-7)', () => {
  async function setup() {
    const env = createTestEnv({
      supervisor: { email: SUPERVISOR_EMAIL, password: SUPERVISOR_PASSWORD },
    });
    await env.core.ensureSupervisor();
    const orgA = await seedAdmin(env);
    const orgB = await seedOrganization(env, 'admin-b@example.test', 'Вторая компания');
    await addMember(env, 'zed-a@example.test', orgA.orgId);
    await addMember(env, 'alpha-a@example.test', orgA.orgId);
    await addMember(env, 'mid-b@example.test', orgB.orgId);
    return { env, orgA, orgB };
  }

  it('AC-024-8: admin видит только свою организацию при любом orgId, по email; user — forbidden; supervisor — все или одну по orgId', async () => {
    const { env, orgB } = await setup();
    const adminToken = (await loginAs(env, ADMIN_EMAIL)).session.accessToken;
    const userToken = (await loginAs(env, 'alpha-a@example.test')).session.accessToken;
    const supToken = (await loginAs(env, SUPERVISOR_EMAIL, SUPERVISOR_PASSWORD)).session
      .accessToken;

    const adminOwn = await env.core.listUsers(adminToken, {});
    const adminOther = await env.core.listUsers(adminToken, { orgId: orgB.orgId });
    expect(adminOwn.ok && adminOwn.value.users.map((u) => u.email)).toEqual([
      'admin@example.test',
      'alpha-a@example.test',
      'zed-a@example.test',
    ]);
    expect(adminOther).toEqual(adminOwn);

    expect(await env.core.listUsers(userToken, {})).toMatchObject({
      ok: false,
      error: { code: 'forbidden' },
    });

    const supAll = await env.core.listUsers(supToken, {});
    expect(supAll.ok && supAll.value.users.map((u) => u.email)).toEqual([
      'admin-b@example.test',
      'admin@example.test',
      'alpha-a@example.test',
      'mid-b@example.test',
      SUPERVISOR_EMAIL,
      'zed-a@example.test',
    ]);
    const supOrgB = await env.core.listUsers(supToken, { orgId: orgB.orgId });
    expect(supOrgB.ok && supOrgB.value.users.map((u) => u.email)).toEqual([
      'admin-b@example.test',
      'mid-b@example.test',
    ]);
  });

  it('AC-024-8: ManagedUser — blocked по blockedAt, createdAt в ISO; без токена — unauthorized', async () => {
    const { env, orgA } = await setup();
    const adminToken = (await loginAs(env, ADMIN_EMAIL)).session.accessToken;
    const members = await env.store.listUsers({ orgId: orgA.orgId });
    const zed = members.find((u) => u.email === 'zed-a@example.test');
    if (!zed) throw new Error('нет тестового пользователя');
    await env.store.updateUser({ id: zed.id, blockedAt: NOW });

    const result = await env.core.listUsers(adminToken, {});
    expect(result.ok && result.value.users.find((u) => u.id === zed.id)).toEqual({
      id: zed.id,
      email: 'zed-a@example.test',
      role: 'user',
      orgId: orgA.orgId,
      blocked: true,
      createdAt: new Date(NOW).toISOString(),
    });

    expect(await env.core.listUsers(undefined, {})).toMatchObject({
      ok: false,
      error: { code: 'unauthorized' },
    });
  });

  it('AC-024-12: supervisor — все организации с верным userCount по name; admin и user — forbidden; без токена — unauthorized', async () => {
    const { env, orgA, orgB } = await setup();
    const adminToken = (await loginAs(env, ADMIN_EMAIL)).session.accessToken;
    const userToken = (await loginAs(env, 'alpha-a@example.test')).session.accessToken;
    const supToken = (await loginAs(env, SUPERVISOR_EMAIL, SUPERVISOR_PASSWORD)).session
      .accessToken;

    expect(await env.core.listOrganizations(adminToken)).toMatchObject({
      ok: false,
      error: { code: 'forbidden' },
    });
    expect(await env.core.listOrganizations(userToken)).toMatchObject({
      ok: false,
      error: { code: 'forbidden' },
    });
    expect(await env.core.listOrganizations(undefined)).toMatchObject({
      ok: false,
      error: { code: 'unauthorized' },
    });

    expect(await env.core.listOrganizations(supToken)).toEqual({
      ok: true,
      value: {
        organizations: [
          {
            id: orgB.orgId,
            name: 'Вторая компания',
            createdAt: new Date(NOW).toISOString(),
            userCount: 2,
          },
          {
            id: orgA.orgId,
            name: 'Компания',
            createdAt: new Date(NOW).toISOString(),
            userCount: 3,
          },
        ],
      },
    });
  });
});
