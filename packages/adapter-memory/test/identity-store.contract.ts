import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { IdentityStore, StoredUser } from '@swag/identity-core';

// Спека 012, AC-012-30: общий набор сценариев хранилища identity. Вызывают его тест памяти
// (identity-store.test.ts) и тест Postgres (T-11). Только методы IdentityStore, без внутреннего состояния.

const NOW = 1_000_000;
const HOUR = 3_600_000;

const unique = (prefix: string): string => `${prefix}-${randomUUID()}@example.test`;

const newUser = (overrides: Partial<StoredUser> = {}): StoredUser => ({
  id: randomUUID(),
  email: unique('user'),
  passwordHash: 'hash',
  role: 'user',
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

function redeem(store: IdentityStore, tokenHash: string, now = NOW) {
  const orgId = randomUUID();
  return store.confirmRegistration({
    tokenHash,
    now,
    org: { id: orgId, name: 'Компания', createdAt: now },
    user: { id: randomUUID(), passwordHash: 'hash', role: 'admin', orgId, createdAt: now },
  });
}

async function confirm(store: IdentityStore, tokenHash: string, email: string, expiresAt?: number) {
  await issue(store, tokenHash, email, expiresAt);
  return redeem(store, tokenHash);
}

async function sessionFor(store: IdentityStore, refreshHash: string, expiresAt = NOW + HOUR) {
  const user = newUser();
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
      const result = await confirm(store, 'tok-ok', email);

      expect(result).toEqual({ status: 'ok', email });
      const found = await store.findUserByEmail(email);
      expect(found).toMatchObject({ email, role: 'admin' });
      const byId = await store.findUserById(found!.id);
      expect(byId?.organization).toMatchObject({ name: 'Компания' });
      expect(byId?.user.orgId).toBe(byId?.organization?.id);
    });

    it('AC-012-30: confirmRegistration повтор тем же токеном — invalid_token', async () => {
      const store = await makeStore();
      await issue(store, 'tok-twice', unique('twice'));
      expect(await redeem(store, 'tok-twice')).toMatchObject({ status: 'ok' });

      expect(await redeem(store, 'tok-twice')).toEqual({ status: 'invalid_token' });
    });

    it('AC-012-30: confirmRegistration просроченный токен — invalid_token', async () => {
      const store = await makeStore();
      const result = await confirm(store, 'tok-expired', unique('late'), NOW - 1);

      expect(result).toEqual({ status: 'invalid_token' });
    });

    it('AC-012-30: confirmRegistration при занятом email — email_taken, токен не гасится', async () => {
      const store = await makeStore();
      const email = unique('taken');
      await store.createUser(newUser({ email }));

      const first = await confirm(store, 'tok-taken', email);
      expect(first).toEqual({ status: 'email_taken' });
      expect(await redeem(store, 'tok-taken')).toEqual({ status: 'email_taken' });
    });

    it('AC-012-30: createUser с занятым email — reject', async () => {
      const store = await makeStore();
      const email = unique('dup');
      await store.createUser(newUser({ email }));

      await expect(store.createUser(newUser({ email }))).rejects.toThrow();
    });

    it('AC-012-30: rotateSession ok — токен меняется, старый становится предыдущим', async () => {
      const store = await makeStore();
      const userId = await sessionFor(store, 'r1');

      const first = await store.rotateSession({
        oldHash: 'r1',
        newHash: 'r2',
        now: NOW + 1,
        expiresAt: NOW + 2 * HOUR,
      });
      expect(first).toEqual({ status: 'ok', userId });

      const second = await store.rotateSession({
        oldHash: 'r2',
        newHash: 'r3',
        now: NOW + 2,
        expiresAt: NOW + 2 * HOUR,
      });
      expect(second).toEqual({ status: 'ok', userId });
    });

    it('AC-012-30: rotateSession reused — сессия отозвана, новый токен тоже invalid', async () => {
      const store = await makeStore();
      const userId = await sessionFor(store, 'q1');
      await store.rotateSession({
        oldHash: 'q1',
        newHash: 'q2',
        now: NOW + 1,
        expiresAt: NOW + HOUR,
      });

      const reused = await store.rotateSession({
        oldHash: 'q1',
        newHash: 'q3',
        now: NOW + 2,
        expiresAt: NOW + HOUR,
      });
      expect(reused).toEqual({ status: 'reused', userId });

      const current = await store.rotateSession({
        oldHash: 'q2',
        newHash: 'q4',
        now: NOW + 3,
        expiresAt: NOW + HOUR,
      });
      expect(current).toEqual({ status: 'invalid' });
    });

    it('AC-012-30: rotateSession invalid — неизвестный, просроченный и отозванный токен', async () => {
      const store = await makeStore();
      await sessionFor(store, 'expired', NOW + 10);
      await sessionFor(store, 'revoked');
      await store.revokeSession('revoked', NOW);

      const unknown = await store.rotateSession({
        oldHash: 'nope',
        newHash: 'n1',
        now: NOW,
        expiresAt: NOW + HOUR,
      });
      const expired = await store.rotateSession({
        oldHash: 'expired',
        newHash: 'n2',
        now: NOW + 10,
        expiresAt: NOW + HOUR,
      });
      const revoked = await store.rotateSession({
        oldHash: 'revoked',
        newHash: 'n3',
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
      await sessionFor(store, 'to-revoke');

      await expect(store.revokeSession('unknown', NOW)).resolves.toBeUndefined();
      await store.revokeSession('to-revoke', NOW);
      const result = await store.rotateSession({
        oldHash: 'to-revoke',
        newHash: 'x',
        now: NOW,
        expiresAt: NOW + HOUR,
      });
      expect(result).toEqual({ status: 'invalid' });
    });

    it('AC-012-30: hasSupervisor — false без супервизора, true после его создания', async () => {
      const store = await makeStore();
      expect(await store.hasSupervisor()).toBe(false);

      await store.createUser(newUser({ role: 'supervisor' }));
      expect(await store.hasSupervisor()).toBe(true);
    });

    it('AC-012-30: findUserById у супервизора — organization null', async () => {
      const store = await makeStore();
      const supervisor = newUser({ role: 'supervisor' });
      await store.createUser(supervisor);

      const found = await store.findUserById(supervisor.id);
      expect(found).toMatchObject({ user: { id: supervisor.id }, organization: null });
      expect(await store.findUserById(randomUUID())).toBeNull();
    });
  });
}
