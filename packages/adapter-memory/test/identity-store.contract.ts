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
    user: { id: userId, passwordHash: 'hash', role: 'admin', orgId, createdAt: now },
  });
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
  });
}
