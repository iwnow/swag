import { describe, expect, it } from 'vitest';
import { ADMIN_EMAIL, HOUR_MS, NOW, createTestEnv, loginAs, seedAdmin } from './fakes.ts';

// Спека 024, T-9: purgeExpired (ядро), AC-024-14.

const DAY_MS = 24 * HOUR_MS;

describe('identity-core — уборка (спека 024, T-9)', () => {
  it('AC-024-14: уборка удаляет просроченные и закрытые старше 7 суток, свежие оставляет; лог identity_purged с числами', async () => {
    const env = createTestEnv();
    const { userId, orgId } = await seedAdmin(env);
    const old = NOW - 8 * DAY_MS;
    const future = NOW + 30 * DAY_MS;

    await env.store.addConfirmation({
      tokenHash: 'old-confirm',
      email: 'old@example.test',
      expiresAt: old,
      createdAt: old,
    });
    await env.store.addConfirmation({
      tokenHash: 'fresh-confirm',
      email: 'fresh@example.test',
      expiresAt: NOW - DAY_MS,
      createdAt: NOW - 2 * DAY_MS,
    });
    await env.store.addInvitation({
      tokenHash: 'old-invite',
      email: 'old-invite@example.test',
      orgId,
      role: 'user',
      invitedBy: userId,
      expiresAt: old,
      createdAt: old,
    });
    await env.store.addInvitation({
      tokenHash: 'fresh-invite',
      email: 'fresh-invite@example.test',
      orgId,
      role: 'user',
      invitedBy: userId,
      expiresAt: future,
      createdAt: NOW,
    });
    await env.store.createSession({
      id: 'old-session',
      userId,
      refreshHash: 'old-session-hash',
      expiresAt: old,
      createdAt: old,
    });
    await env.store.createSession({
      id: 'closed-old',
      userId,
      refreshHash: 'closed-old-hash',
      expiresAt: future,
      createdAt: old,
    });
    await env.store.revokeSession('closed-old-hash', old);

    await env.core.purgeExpired();
    expect(env.entries.filter((e) => e.msg === 'identity_purged')).toEqual([
      {
        level: 'info',
        msg: 'identity_purged',
        ctx: { confirmations: 1, invitations: 1, sessions: 2 },
      },
    ]);

    const issued = await loginAs(env, ADMIN_EMAIL);
    expect(await env.core.refresh(issued.refreshToken)).toMatchObject({ ok: true });
    await env.core.purgeExpired();
    expect(env.entries.filter((e) => e.msg === 'identity_purged').at(-1)).toEqual({
      level: 'info',
      msg: 'identity_purged',
      ctx: { confirmations: 0, invitations: 0, sessions: 0 },
    });
  });
});
