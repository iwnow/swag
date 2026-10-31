import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  ADMIN_EMAIL,
  ADMIN_PASSWORD,
  NOW,
  addMember,
  createTestEnv,
  loginAs,
  seedAdmin,
  seedOrganization,
  type TestEnv,
} from './fakes.ts';

// Спека 024, T-9: updateUser и tokenRevocations (ядро), AC-024-11.

const SUPERVISOR_EMAIL = 'supervisor@example.test';
const ACCESS_TTL_MS = 900_000;

async function addSupervisor(env: TestEnv): Promise<string> {
  const id = randomUUID();
  await env.store.createUser({
    id,
    email: SUPERVISOR_EMAIL,
    passwordHash: `fake-hash:${ADMIN_PASSWORD}`,
    role: 'supervisor',
    orgId: null,
    createdAt: NOW,
    blockedAt: null,
    tokensValidAfter: null,
  });
  return id;
}

describe('identity-core — управление пользователями (спека 024, T-9)', () => {
  it('AC-024-11: администратор меняет пользователя своей организации — ManagedUser; лог user_updated', async () => {
    const env = createTestEnv();
    const org = await seedOrganization(env, 'a-admin@example.test', 'Компания A');
    const member = await addMember(env, 'a-member@example.test', org.orgId);
    const admin = await loginAs(env, 'a-admin@example.test');

    const result = await env.core.updateUser(admin.session.accessToken, member, { role: 'admin' });
    expect(result).toEqual({
      ok: true,
      value: {
        id: member,
        email: 'a-member@example.test',
        role: 'admin',
        orgId: org.orgId,
        blocked: false,
        createdAt: new Date(NOW).toISOString(),
      },
    });
    expect(env.entries.filter((e) => e.msg === 'user_updated')).toEqual([
      {
        level: 'info',
        msg: 'user_updated',
        ctx: { userId: org.userId, targetId: member, role: 'admin', blocked: false },
      },
    ]);
  });

  it('AC-024-11: пользователь другой организации и несуществующий — not_found', async () => {
    const env = createTestEnv();
    await seedOrganization(env, 'a-admin@example.test', 'Компания A');
    const orgB = await seedOrganization(env, 'b-admin@example.test', 'Компания B');
    const memberB = await addMember(env, 'b-member@example.test', orgB.orgId);
    const admin = await loginAs(env, 'a-admin@example.test');

    const foreign = await env.core.updateUser(admin.session.accessToken, memberB, {
      blocked: true,
    });
    expect(foreign).toMatchObject({ ok: false, error: { code: 'not_found' } });
    const missing = await env.core.updateUser(admin.session.accessToken, randomUUID(), {
      blocked: true,
    });
    expect(missing).toMatchObject({ ok: false, error: { code: 'not_found' } });
  });

  it('AC-024-11: себе и супервизору — forbidden', async () => {
    const env = createTestEnv();
    const { userId } = await seedAdmin(env);
    const supervisorId = await addSupervisor(env);
    const admin = await loginAs(env, ADMIN_EMAIL);
    const supervisor = await loginAs(env, SUPERVISOR_EMAIL);

    const self = await env.core.updateUser(admin.session.accessToken, userId, { blocked: true });
    expect(self).toMatchObject({ ok: false, error: { code: 'forbidden' } });
    const toSupervisor = await env.core.updateUser(admin.session.accessToken, supervisorId, {
      blocked: true,
    });
    expect(toSupervisor).toMatchObject({ ok: false, error: { code: 'forbidden' } });
    const supervisorSelf = await env.core.updateUser(supervisor.session.accessToken, supervisorId, {
      role: 'user',
    });
    expect(supervisorSelf).toMatchObject({ ok: false, error: { code: 'forbidden' } });
  });

  it('AC-024-11: тело без полей — validation_error; роль user — forbidden', async () => {
    const env = createTestEnv();
    const org = await seedOrganization(env, 'a-admin@example.test', 'Компания A');
    const member = await addMember(env, 'a-member@example.test', org.orgId);
    const admin = await loginAs(env, 'a-admin@example.test');
    const memberSession = await loginAs(env, 'a-member@example.test');

    const empty = await env.core.updateUser(admin.session.accessToken, member, {});
    expect(empty).toMatchObject({ ok: false, error: { code: 'validation_error' } });
    const asUser = await env.core.updateUser(memberSession.session.accessToken, member, {
      blocked: true,
    });
    expect(asUser).toMatchObject({ ok: false, error: { code: 'forbidden' } });
  });

  it('AC-024-11: супервизор меняет пользователя любой организации — ok', async () => {
    const env = createTestEnv();
    const org = await seedOrganization(env, 'a-admin@example.test', 'Компания A');
    const member = await addMember(env, 'a-member@example.test', org.orgId);
    await addSupervisor(env);
    const supervisor = await loginAs(env, SUPERVISOR_EMAIL);

    const result = await env.core.updateUser(supervisor.session.accessToken, member, {
      blocked: true,
    });
    expect(result).toMatchObject({ ok: true, value: { id: member, blocked: true } });
  });

  it('AC-024-11: после блокировки и смены роли старый токен цели не работает; в tokenRevocations — записи с blocked по случаю', async () => {
    const env = createTestEnv();
    const org = await seedOrganization(env, 'a-admin@example.test', 'Компания A');
    const blockedMember = await addMember(env, 'blocked@example.test', org.orgId);
    const roleMember = await addMember(env, 'role@example.test', org.orgId);
    const admin = await loginAs(env, 'a-admin@example.test');
    const blockedToken = (await loginAs(env, 'blocked@example.test')).session.accessToken;
    const roleToken = (await loginAs(env, 'role@example.test')).session.accessToken;

    env.clock.advance(1000);
    await env.core.updateUser(admin.session.accessToken, blockedMember, { blocked: true });
    await env.core.updateUser(admin.session.accessToken, roleMember, { role: 'admin' });

    expect(await env.core.me(blockedToken)).toMatchObject({
      ok: false,
      error: { code: 'unauthorized' },
    });
    expect(await env.core.me(roleToken)).toMatchObject({
      ok: false,
      error: { code: 'unauthorized' },
    });

    const { revocations } = await env.core.tokenRevocations();
    expect(revocations).toEqual(
      expect.arrayContaining([
        { userId: blockedMember, validAfter: NOW + 1000, blocked: true },
        { userId: roleMember, validAfter: NOW + 1000, blocked: false },
      ]),
    );
  });

  it('AC-024-11: без изменений отзыва нет — та же роль, повторная блокировка, разблокировка', async () => {
    const env = createTestEnv();
    const org = await seedOrganization(env, 'a-admin@example.test', 'Компания A');
    const member = await addMember(env, 'a-member@example.test', org.orgId);
    const admin = await loginAs(env, 'a-admin@example.test');
    const memberToken = (await loginAs(env, 'a-member@example.test')).session.accessToken;
    const validAfterOf = async (): Promise<number | undefined> =>
      (await env.core.tokenRevocations()).revocations.find((r) => r.userId === member)?.validAfter;

    env.clock.advance(1000);
    await env.core.updateUser(admin.session.accessToken, member, { role: 'user' });
    expect(await validAfterOf()).toBeUndefined();
    expect(await env.core.me(memberToken)).toMatchObject({ ok: true });

    env.clock.advance(1000);
    await env.core.updateUser(admin.session.accessToken, member, { blocked: true });
    const blockedValidAfter = await validAfterOf();
    expect(blockedValidAfter).toBe(NOW + 2000);

    env.clock.advance(5000);
    await env.core.updateUser(admin.session.accessToken, member, { blocked: true });
    expect(await validAfterOf()).toBe(blockedValidAfter);

    env.clock.advance(5000);
    await env.core.updateUser(admin.session.accessToken, member, { blocked: false });
    expect(await validAfterOf()).toBe(blockedValidAfter);
  });

  it('AC-024-13: tokenRevocations — записи старше accessTtl не попадают в список', async () => {
    const env = createTestEnv();
    const org = await seedOrganization(env, 'a-admin@example.test', 'Компания A');
    const old = await addMember(env, 'old@example.test', org.orgId);
    const fresh = await addMember(env, 'fresh@example.test', org.orgId);
    await env.store.updateUser({ id: old, revokeAt: NOW - ACCESS_TTL_MS - 1 });
    await env.store.updateUser({ id: fresh, revokeAt: NOW - ACCESS_TTL_MS + 1 });

    const { revocations } = await env.core.tokenRevocations();
    expect(revocations.map((r) => r.userId)).toEqual([fresh]);
  });
});
