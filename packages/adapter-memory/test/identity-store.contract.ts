import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { IdentityStore, StoredUser } from '@swag/identity-core';

// Спека 012, AC-012-30: общий набор сценариев хранилища identity. Вызывают его тест памяти
// (identity-store.test.ts) и тест Postgres (T-11). Только методы IdentityStore, без внутреннего состояния.
// Набор не требует пустой базы: токены, хэши, email и id уникальны на каждый прогон.

const NOW = 1_000_000;
const HOUR = 3_600_000;

const unique = (prefix: string): string => `${prefix}-${randomUUID()}@example.test`;
const fresh = (prefix: string): string => `${prefix}-${randomUUID()}`;

// Пользователь без организации создаётся только супервизором (check в 4.9).
// Пользователь с организацией появляется только через confirmRegistration.
const newSupervisor = (overrides: Partial<StoredUser> = {}): StoredUser => ({
  id: randomUUID(),
  email: unique('supervisor'),
  passwordHash: 'hash',
  role: 'supervisor',
  orgId: null,
  createdAt: NOW,
  blockedAt: null,
  tokensValidAfter: null,
  ...overrides,
});

async function issue(
  store: IdentityStore,
  tokenHash: string,
  email: string,
  expiresAt = NOW + HOUR,
): Promise<void> {
  await store.addConfirmation({ tokenHash, email, expiresAt, createdAt: NOW });
}

function redeem(
  store: IdentityStore,
  tokenHash: string,
  { now = NOW, userId = randomUUID() }: { now?: number; userId?: string } = {},
) {
  const orgId = randomUUID();
  return store.confirmRegistration({
    tokenHash,
    now,
    org: { id: orgId, name: 'Компания', createdAt: now },
    user: {
      id: userId,
      passwordHash: 'hash',
      role: 'admin',
      orgId,
      createdAt: now,
      blockedAt: null,
      tokensValidAfter: null,
    },
  });
}

// Организация с администратором через confirmRegistration; возвращает id организации и администратора.
async function newOrganization(store: IdentityStore, name: string) {
  const tokenHash = fresh('tok-org');
  const email = unique('admin');
  await issue(store, tokenHash, email);
  const orgId = randomUUID();
  const adminId = randomUUID();
  await store.confirmRegistration({
    tokenHash,
    now: NOW,
    org: { id: orgId, name, createdAt: NOW },
    user: {
      id: adminId,
      passwordHash: 'hash',
      role: 'admin',
      orgId,
      createdAt: NOW,
      blockedAt: null,
      tokensValidAfter: null,
    },
  });
  return { orgId, adminId, name };
}

async function sessionFor(store: IdentityStore, refreshHash: string, expiresAt = NOW + HOUR) {
  const user = newSupervisor();
  await store.createUser(user);
  await store.createSession({
    id: randomUUID(),
    userId: user.id,
    refreshHash,
    expiresAt,
    createdAt: NOW,
  });
  return user.id;
}

// Пользователь организации, принятый по приглашению от администратора org.
async function invitedUser(
  store: IdentityStore,
  org: { orgId: string; adminId: string },
  email: string,
  role: 'user' | 'admin' = 'user',
): Promise<string> {
  const tokenHash = fresh('tok-inv');
  await store.addInvitation({
    tokenHash,
    email,
    orgId: org.orgId,
    role,
    invitedBy: org.adminId,
    expiresAt: NOW + HOUR,
    createdAt: NOW,
  });
  const id = randomUUID();
  const result = await store.acceptInvitation({
    tokenHash,
    now: NOW,
    user: { id, passwordHash: 'hash', createdAt: NOW },
  });
  if (result.status !== 'ok') throw new Error(`invitation not accepted: ${result.status}`);
  return id;
}

export function identityStoreContract(
  name: string,
  makeStore: () => Promise<IdentityStore> | IdentityStore,
): void {
  describe(`identity store: ${name}`, () => {
    it('AC-012-30: confirmRegistration ok создаёт организацию и администратора с email из записи', async () => {
      const store = await makeStore();
      const email = unique('owner');
      const tokenHash = fresh('tok-ok');
      await issue(store, tokenHash, email);

      expect(await redeem(store, tokenHash)).toEqual({ status: 'ok', email });
      const found = await store.findUserByEmail(email);
      expect(found).toMatchObject({ email, role: 'admin' });
      const byId = await store.findUserById(found!.id);
      expect(byId?.organization).toMatchObject({ name: 'Компания' });
      expect(byId?.user.orgId).toBe(byId?.organization?.id);
    });

    it('AC-012-30: confirmRegistration повтор тем же токеном — invalid_token', async () => {
      const store = await makeStore();
      const tokenHash = fresh('tok-twice');
      await issue(store, tokenHash, unique('twice'));
      expect(await redeem(store, tokenHash)).toMatchObject({ status: 'ok' });

      expect(await redeem(store, tokenHash)).toEqual({ status: 'invalid_token' });
    });

    it('AC-012-30: confirmRegistration просроченный токен — invalid_token', async () => {
      const store = await makeStore();
      const tokenHash = fresh('tok-expired');
      await issue(store, tokenHash, unique('late'), NOW - 1);

      expect(await redeem(store, tokenHash)).toEqual({ status: 'invalid_token' });
    });

    it('AC-012-30: confirmRegistration при expiresAt === now — invalid_token (срок по 4.3: expires_at > now)', async () => {
      const store = await makeStore();
      const tokenHash = fresh('tok-boundary');
      await issue(store, tokenHash, unique('boundary'), NOW);

      expect(await redeem(store, tokenHash, { now: NOW })).toEqual({ status: 'invalid_token' });
    });

    it('AC-012-30: confirmRegistration с неизвестным токеном — invalid_token', async () => {
      const store = await makeStore();

      expect(await redeem(store, fresh('tok-unknown'))).toEqual({ status: 'invalid_token' });
    });

    it('AC-012-30: confirmRegistration при занятом email — email_taken, токен не гасится, пользователь не создан', async () => {
      const store = await makeStore();
      const email = unique('taken');
      await store.createUser(newSupervisor({ email }));
      const tokenHash = fresh('tok-taken');
      await issue(store, tokenHash, email);
      const userId = randomUUID();

      expect(await redeem(store, tokenHash, { userId })).toEqual({ status: 'email_taken' });
      expect(await store.findUserById(userId)).toBeNull();
      expect(await redeem(store, tokenHash, { userId })).toEqual({ status: 'email_taken' });
    });

    it('AC-012-30: createUser с занятым email — reject', async () => {
      const store = await makeStore();
      const email = unique('dup');
      await store.createUser(newSupervisor({ email }));

      await expect(store.createUser(newSupervisor({ email }))).rejects.toThrow();
    });

    it('AC-012-30: rotateSession ok — токен меняется дважды подряд, сессия остаётся живой', async () => {
      const store = await makeStore();
      const r1 = fresh('r1');
      const r2 = fresh('r2');
      const r3 = fresh('r3');
      const userId = await sessionFor(store, r1);

      const first = await store.rotateSession({
        oldHash: r1,
        newHash: r2,
        now: NOW + 1,
        expiresAt: NOW + 2 * HOUR,
      });
      expect(first).toEqual({ status: 'ok', userId });

      const second = await store.rotateSession({
        oldHash: r2,
        newHash: r3,
        now: NOW + 2,
        expiresAt: NOW + 2 * HOUR,
      });
      expect(second).toEqual({ status: 'ok', userId });
    });

    it('AC-012-30: rotateSession reused — сессия отозвана, повтор предыдущего и нового токена дают invalid', async () => {
      const store = await makeStore();
      const q1 = fresh('q1');
      const q2 = fresh('q2');
      const userId = await sessionFor(store, q1);
      await store.rotateSession({
        oldHash: q1,
        newHash: q2,
        now: NOW + 1,
        expiresAt: NOW + HOUR,
      });

      const reused = await store.rotateSession({
        oldHash: q1,
        newHash: fresh('q3'),
        now: NOW + 2,
        expiresAt: NOW + HOUR,
      });
      expect(reused).toEqual({ status: 'reused', userId });

      const repeatPrevious = await store.rotateSession({
        oldHash: q1,
        newHash: fresh('q4'),
        now: NOW + 3,
        expiresAt: NOW + HOUR,
      });
      const current = await store.rotateSession({
        oldHash: q2,
        newHash: fresh('q5'),
        now: NOW + 4,
        expiresAt: NOW + HOUR,
      });
      expect([repeatPrevious, current]).toEqual([{ status: 'invalid' }, { status: 'invalid' }]);
    });

    it('AC-012-30: rotateSession invalid — неизвестный, просроченный и отозванный токен', async () => {
      const store = await makeStore();
      const expiredHash = fresh('expired');
      const revokedHash = fresh('revoked');
      await sessionFor(store, expiredHash, NOW + 10);
      await sessionFor(store, revokedHash);
      await store.revokeSession(revokedHash, NOW);

      const unknown = await store.rotateSession({
        oldHash: fresh('nope'),
        newHash: fresh('n1'),
        now: NOW,
        expiresAt: NOW + HOUR,
      });
      const expired = await store.rotateSession({
        oldHash: expiredHash,
        newHash: fresh('n2'),
        now: NOW + 10,
        expiresAt: NOW + HOUR,
      });
      const revoked = await store.rotateSession({
        oldHash: revokedHash,
        newHash: fresh('n3'),
        now: NOW,
        expiresAt: NOW + HOUR,
      });
      expect([unknown, expired, revoked]).toEqual([
        { status: 'invalid' },
        { status: 'invalid' },
        { status: 'invalid' },
      ]);
    });

    it('AC-012-30: revokeSession отзывает сессию; неизвестный токен — без ошибки', async () => {
      const store = await makeStore();
      const hash = fresh('to-revoke');
      await sessionFor(store, hash);

      await expect(store.revokeSession(fresh('unknown'), NOW)).resolves.toBeUndefined();
      await store.revokeSession(hash, NOW);
      const result = await store.rotateSession({
        oldHash: hash,
        newHash: fresh('x'),
        now: NOW,
        expiresAt: NOW + HOUR,
      });
      expect(result).toEqual({ status: 'invalid' });
    });

    it('AC-012-30: hasSupervisor — true после создания супервизора', async () => {
      const store = await makeStore();
      await store.createUser(newSupervisor());

      expect(await store.hasSupervisor()).toBe(true);
    });

    it('AC-012-30: findUserById у супервизора — organization null, неизвестный id — null', async () => {
      const store = await makeStore();
      const supervisor = newSupervisor();
      await store.createUser(supervisor);

      const found = await store.findUserById(supervisor.id);
      expect(found).toMatchObject({ user: { id: supervisor.id }, organization: null });
      expect(await store.findUserById(randomUUID())).toBeNull();
    });

    it('AC-024-4: listUsers по orgId и без фильтра — сортировка по email', async () => {
      const store = await makeStore();
      const org = await newOrganization(store, 'Список');
      const other = await newOrganization(store, 'Чужая');
      const c = await invitedUser(store, org, `ccc-${randomUUID()}@example.test`);
      const a = await invitedUser(store, org, `aaa-${randomUUID()}@example.test`);
      const b = await invitedUser(store, org, `bbb-${randomUUID()}@example.test`);
      const foreign = await invitedUser(store, other, unique('foreign'));

      const inOrg = (await store.listUsers({ orgId: org.orgId })).map((user) => user.id);
      expect([...inOrg].sort()).toEqual([a, b, c, org.adminId].sort());
      const all = (await store.listUsers({})).map((user) => user.id);
      expect(all).toEqual(expect.arrayContaining([a, b, c, org.adminId, foreign]));
      expect(all.indexOf(a)).toBeLessThan(all.indexOf(org.adminId));
      expect(all.indexOf(org.adminId)).toBeLessThan(all.indexOf(b));
      expect(all.indexOf(b)).toBeLessThan(all.indexOf(c));
      expect(inOrg.indexOf(a)).toBeLessThan(inOrg.indexOf(b));
      expect(inOrg.indexOf(b)).toBeLessThan(inOrg.indexOf(c));
    });

    it('AC-024-4: updateUser меняет только переданные поля, blockedAt: null снимает блокировку', async () => {
      const store = await makeStore();
      const org = await newOrganization(store, 'Поля');
      const userId = await invitedUser(store, org, unique('fields'));

      const promoted = await store.updateUser({ id: userId, role: 'admin' });
      expect(promoted).toMatchObject({
        id: userId,
        role: 'admin',
        orgId: org.orgId,
        blockedAt: null,
      });

      const blocked = await store.updateUser({ id: userId, blockedAt: NOW + 5 });
      expect(blocked).toMatchObject({ role: 'admin', blockedAt: NOW + 5, tokensValidAfter: null });

      const unblocked = await store.updateUser({ id: userId, blockedAt: null });
      expect(unblocked).toMatchObject({ role: 'admin', blockedAt: null, orgId: org.orgId });
    });

    it('AC-024-4: updateUser с revokeAt отзывает живые сессии этого пользователя, чужие не трогает', async () => {
      const store = await makeStore();
      const org = await newOrganization(store, 'Отзыв');
      const userId = await invitedUser(store, org, unique('revoke'));
      const bystanderId = await invitedUser(store, org, unique('bystander'));
      const sessions = [fresh('rv-1'), fresh('rv-2')];
      for (const refreshHash of sessions) {
        await store.createSession({
          id: randomUUID(),
          userId,
          refreshHash,
          expiresAt: NOW + HOUR,
          createdAt: NOW,
        });
      }
      const bystanderHash = fresh('rv-other');
      await store.createSession({
        id: randomUUID(),
        userId: bystanderId,
        refreshHash: bystanderHash,
        expiresAt: NOW + HOUR,
        createdAt: NOW,
      });

      const updated = await store.updateUser({ id: userId, revokeAt: NOW + 10 });
      expect(updated.tokensValidAfter).toBe(NOW + 10);

      const rotate = (oldHash: string) =>
        store.rotateSession({
          oldHash,
          newHash: fresh('rv-new'),
          now: NOW + 11,
          expiresAt: NOW + HOUR,
        });
      expect(await rotate(sessions[0]!)).toEqual({ status: 'invalid' });
      expect(await rotate(sessions[1]!)).toEqual({ status: 'invalid' });
      expect(await rotate(bystanderHash)).toEqual({ status: 'ok', userId: bystanderId });
      expect((await store.findUserById(bystanderId))?.user.tokensValidAfter).toBeNull();
    });

    it('AC-024-4: acceptInvitation ok создаёт пользователя с ролью и организацией приглашения', async () => {
      const store = await makeStore();
      const org = await newOrganization(store, 'Приглашение');
      const email = unique('invited');
      const tokenHash = fresh('tok-accept');
      await store.addInvitation({
        tokenHash,
        email,
        orgId: org.orgId,
        role: 'admin',
        invitedBy: org.adminId,
        expiresAt: NOW + HOUR,
        createdAt: NOW,
      });
      const id = randomUUID();

      const result = await store.acceptInvitation({
        tokenHash,
        now: NOW,
        user: { id, passwordHash: 'hash', createdAt: NOW },
      });
      expect(result).toEqual({
        status: 'ok',
        user: {
          id,
          email,
          passwordHash: 'hash',
          role: 'admin',
          orgId: org.orgId,
          createdAt: NOW,
          blockedAt: null,
          tokensValidAfter: null,
        },
        organization: { id: org.orgId, name: 'Приглашение', createdAt: NOW },
      });
      expect(await store.findUserByEmail(email)).toMatchObject({ id, role: 'admin' });
    });

    it('AC-024-4: acceptInvitation повтор тем же токеном — invalid_token', async () => {
      const store = await makeStore();
      const org = await newOrganization(store, 'Повтор');
      const tokenHash = fresh('tok-twice-inv');
      await store.addInvitation({
        tokenHash,
        email: unique('once'),
        orgId: org.orgId,
        role: 'user',
        invitedBy: org.adminId,
        expiresAt: NOW + HOUR,
        createdAt: NOW,
      });
      const accept = (id: string) =>
        store.acceptInvitation({
          tokenHash,
          now: NOW,
          user: { id, passwordHash: 'hash', createdAt: NOW },
        });
      expect((await accept(randomUUID())).status).toBe('ok');

      expect(await accept(randomUUID())).toEqual({ status: 'invalid_token' });
    });

    it('AC-024-4: acceptInvitation просроченное (expiresAt <= now) и неизвестный токен — invalid_token', async () => {
      const store = await makeStore();
      const org = await newOrganization(store, 'Срок');
      const expiredHash = fresh('tok-inv-expired');
      await store.addInvitation({
        tokenHash: expiredHash,
        email: unique('late-inv'),
        orgId: org.orgId,
        role: 'user',
        invitedBy: org.adminId,
        expiresAt: NOW,
        createdAt: NOW - HOUR,
      });
      const accept = (tokenHash: string) =>
        store.acceptInvitation({
          tokenHash,
          now: NOW,
          user: { id: randomUUID(), passwordHash: 'hash', createdAt: NOW },
        });

      expect(await accept(expiredHash)).toEqual({ status: 'invalid_token' });
      expect(await accept(fresh('tok-inv-unknown'))).toEqual({ status: 'invalid_token' });
    });

    it('AC-024-4: acceptInvitation при занятом email — email_taken, приглашение не погашено', async () => {
      const store = await makeStore();
      const org = await newOrganization(store, 'Занятый');
      const email = unique('busy');
      await store.createUser(newSupervisor({ email }));
      const tokenHash = fresh('tok-busy');
      await store.addInvitation({
        tokenHash,
        email,
        orgId: org.orgId,
        role: 'user',
        invitedBy: org.adminId,
        expiresAt: NOW + HOUR,
        createdAt: NOW,
      });
      const userId = randomUUID();
      const accept = () =>
        store.acceptInvitation({
          tokenHash,
          now: NOW,
          user: { id: userId, passwordHash: 'hash', createdAt: NOW },
        });

      expect(await accept()).toEqual({ status: 'email_taken' });
      expect(await store.findUserById(userId)).toBeNull();
      expect(await accept()).toEqual({ status: 'email_taken' });
    });

    it('AC-024-4: listOrganizations — userCount верен, сортировка по name', async () => {
      const store = await makeStore();
      const second = await newOrganization(store, `sort-b-${randomUUID()}`);
      const first = await newOrganization(store, `sort-a-${randomUUID()}`);
      await invitedUser(store, first, unique('count'));
      const list = await store.listOrganizations();

      expect(list.find((org) => org.id === first.orgId)).toMatchObject({
        name: first.name,
        userCount: 2,
      });
      expect(list.find((org) => org.id === second.orgId)).toMatchObject({
        name: second.name,
        userCount: 1,
      });
      const ids = list.map((org) => org.id);
      expect(ids.indexOf(first.orgId)).toBeLessThan(ids.indexOf(second.orgId));
    });

    it('AC-024-4: tokenRevocations(since) — только tokensValidAfter > since, blocked по blockedAt', async () => {
      const store = await makeStore();
      const org = await newOrganization(store, 'Отзывы');
      const blockedId = await invitedUser(store, org, unique('blocked'));
      const revokedId = await invitedUser(store, org, unique('revoked'));
      const staleId = await invitedUser(store, org, unique('stale'));
      await store.updateUser({ id: blockedId, blockedAt: NOW + 100, revokeAt: NOW + 100 });
      await store.updateUser({ id: revokedId, revokeAt: NOW + 60 });
      await store.updateUser({ id: staleId, revokeAt: NOW + 50 });

      const list = await store.tokenRevocations(NOW + 50);
      expect(list).toEqual(
        expect.arrayContaining([
          { userId: blockedId, validAfter: NOW + 100, blocked: true },
          { userId: revokedId, validAfter: NOW + 60, blocked: false },
        ]),
      );
      expect(list.map((item) => item.userId)).not.toContain(staleId);
    });

    it('AC-024-4: purge удаляет просроченные и закрытые старые записи, свежие остаются', async () => {
      const store = await makeStore();
      const org = await newOrganization(store, 'Уборка');
      // before = 0: старше него записей в общем хранилище нет, кроме созданных здесь.
      await issue(store, fresh('purge-confirm-old'), unique('purge-old'), -10);
      const freshConfirm = fresh('purge-confirm-new');
      await issue(store, freshConfirm, unique('purge-new'), 10);
      await store.addInvitation({
        tokenHash: fresh('purge-inv-old'),
        email: unique('purge-inv-old'),
        orgId: org.orgId,
        role: 'user',
        invitedBy: org.adminId,
        expiresAt: -10,
        createdAt: NOW,
      });
      await store.addInvitation({
        tokenHash: fresh('purge-inv-new'),
        email: unique('purge-inv-new'),
        orgId: org.orgId,
        role: 'user',
        invitedBy: org.adminId,
        expiresAt: 10,
        createdAt: NOW,
      });
      await sessionFor(store, fresh('purge-s-old'), -10);
      const closedSession = fresh('purge-s-closed');
      await sessionFor(store, closedSession);
      await store.revokeSession(closedSession, -5);
      const freshSession = fresh('purge-s-fresh');
      await sessionFor(store, freshSession, 100);

      expect(await store.purge(0)).toEqual({ confirmations: 1, invitations: 1, sessions: 2 });
      expect(
        await store.rotateSession({
          oldHash: freshSession,
          newHash: fresh('purge-s-next'),
          now: 5,
          expiresAt: NOW + HOUR,
        }),
      ).toMatchObject({ status: 'ok' });
      expect(await redeem(store, freshConfirm, { now: 5 })).toMatchObject({ status: 'ok' });
    });
  });
}
