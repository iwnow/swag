import { describe, expect, it, vi } from 'vitest';
import { createTestEnv, seedAdmin } from './fakes.ts';

// Спека 012, T-10: ensureSupervisor (4.2), REQ-012-15, AC-012-20, AC-012-21 (ядро).

const SUPERVISOR = { email: 'root@example.test', password: 'supervisor password 1' };

describe('identity-core — ensureSupervisor (спека 012, T-10)', () => {
  it('AC-012-20: супервизор создаётся без организации, лог info supervisor_created; повторный вызов ничего не меняет', async () => {
    const env = createTestEnv({ supervisor: SUPERVISOR });
    const createSpy = vi.spyOn(env.store, 'createUser');

    await env.core.ensureSupervisor();
    await env.core.ensureSupervisor();

    expect(createSpy).toHaveBeenCalledTimes(1);
    const user = await env.store.findUserByEmail(SUPERVISOR.email);
    expect(user).toMatchObject({ role: 'supervisor', orgId: null });
    expect(user?.passwordHash).not.toBe(SUPERVISOR.password);
    expect(await env.hasher.verify(user?.passwordHash ?? '', SUPERVISOR.password)).toBe(true);
    const created = env.entries.filter((e) => e.msg === 'supervisor_created');
    expect(created).toEqual([
      { level: 'info', msg: 'supervisor_created', ctx: { userId: user?.id } },
    ]);
  });

  it('REQ-012-15: supervisor = null — ничего не создаётся', async () => {
    const env = createTestEnv({ supervisor: null });
    await env.core.ensureSupervisor();
    expect(await env.store.hasSupervisor()).toBe(false);
    expect(env.entries).toEqual([]);
  });

  it('REQ-012-15: email занят администратором — ensureSupervisor бросает, супервизор не создан', async () => {
    const env = createTestEnv({
      supervisor: { email: 'admin@example.test', password: SUPERVISOR.password },
    });
    await seedAdmin(env);
    await expect(env.core.ensureSupervisor()).rejects.toThrow('supervisor email taken');
    expect(await env.store.hasSupervisor()).toBe(false);
  });

  it('AC-012-21 (ядро): вход супервизора — org и organization null, в утверждениях org = null', async () => {
    const env = createTestEnv({ supervisor: SUPERVISOR });
    await env.core.ensureSupervisor();

    const result = await env.core.login(
      { email: SUPERVISOR.email, password: SUPERVISOR.password },
      { ip: '10.0.0.5' },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.session.organization).toBeNull();
    expect(result.value.session.user).toMatchObject({ role: 'supervisor', orgId: null });
    expect(await env.verifier.verify(result.value.session.accessToken)).toMatchObject({
      role: 'supervisor',
      org: null,
    });
  });
});
