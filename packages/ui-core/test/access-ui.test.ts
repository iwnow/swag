import { describe, expect, it } from 'vitest';
import { UserUpdate, type AuthMe, type ManagedUser, type Role } from '@swag/contracts';
import {
  canOpen,
  isLocalRemoteUrl,
  navigationFor,
  safeReturnTo,
  userActionBody,
  userActions,
  type UiArea,
  type UserAction,
} from '../src/index.ts';

const ORG_A = '5a1d0000-0000-4000-8000-00000000000a';
const ORG_B = '5a1d0000-0000-4000-8000-00000000000b';
const ME_ID = '6f1c2b1e-0000-4000-8000-000000000001';

const areas: UiArea[] = ['swarms', 'balance', 'admin', 'supervisor'];

function me(role: Role, orgId: string | null, id = ME_ID): AuthMe {
  return {
    user: { id, email: `${role}@example.test`, role, orgId },
    organization: orgId === null ? null : { id: orgId, name: 'Организация' },
  };
}

const user = (overrides: Partial<ManagedUser>): ManagedUser => ({
  id: '6f1c2b1e-0000-4000-8000-0000000000f0',
  email: 'target@example.test',
  role: 'user',
  orgId: ORG_A,
  blocked: false,
  createdAt: '2026-10-01T10:00:00.000Z',
  ...overrides,
});

describe('access ui', () => {
  it('AC-014-2: canOpen и navigationFor по ролям и таблице 4.2', () => {
    const plain = me('user', ORG_A);
    expect(areas.map((area) => canOpen(area, plain))).toEqual([true, true, false, false]);
    expect(navigationFor(plain).map((item) => item.area)).toEqual(['swarms', 'balance']);

    const admin = me('admin', ORG_A);
    expect(areas.map((area) => canOpen(area, admin))).toEqual([true, true, true, false]);
    expect(navigationFor(admin).map((item) => item.label)).toEqual(['Рои', 'Баланс', 'Админка']);
    expect(navigationFor(admin).map((item) => item.path)).toEqual([
      '/',
      '/balance',
      '/admin/users',
    ]);

    const supervisor = me('supervisor', null);
    expect(areas.map((area) => canOpen(area, supervisor))).toEqual([true, false, false, true]);
    expect(navigationFor(supervisor).map((item) => item.label)).toEqual(['Рои', 'Организации']);
  });

  it('AC-014-2: без пользователя ничего не открывается', () => {
    expect(areas.map((area) => canOpen(area, null))).toEqual([false, false, false, false]);
    expect(navigationFor(null)).toEqual([]);
  });

  it('AC-014-3: userActions администратора организации A', () => {
    const admin = me('admin', ORG_A);

    expect(userActions(admin, user({ id: ME_ID, role: 'admin' }))).toEqual([]);
    expect(userActions(admin, user({ role: 'supervisor', orgId: null }))).toEqual([]);
    expect(userActions(admin, user({ orgId: ORG_B }))).toEqual([]);
    expect(userActions(admin, user({ role: 'user', orgId: ORG_A }))).toEqual([
      'make_admin',
      'block',
    ]);
    expect(userActions(admin, user({ role: 'admin', orgId: ORG_A }))).toEqual([
      'make_user',
      'block',
    ]);
    expect(userActions(admin, user({ role: 'user', orgId: ORG_A, blocked: true }))).toEqual([
      'make_admin',
      'unblock',
    ]);
  });

  it('AC-014-3: супервизор видит действия над администратором организации B', () => {
    const supervisor = me('supervisor', null);

    expect(userActions(supervisor, user({ role: 'admin', orgId: ORG_B }))).toEqual([
      'make_user',
      'block',
    ]);
  });

  it('AC-014-3: пользователь без user.manage не получает действий', () => {
    const plain = me('user', ORG_A);

    expect(userActions(plain, user({ role: 'user', orgId: ORG_A }))).toEqual([]);
    expect(userActions(plain, user({ role: 'admin', orgId: ORG_A }))).toEqual([]);
  });

  it('AC-014-3: userActionBody даёт тело 4.2, которое проходит UserUpdate', () => {
    const actions: UserAction[] = ['make_admin', 'make_user', 'block', 'unblock'];
    const bodies = actions.map((action) => userActionBody(action));

    expect(bodies).toEqual([
      { role: 'admin' },
      { role: 'user' },
      { blocked: true },
      { blocked: false },
    ]);
    for (const body of bodies) expect(UserUpdate.safeParse(body).success).toBe(true);
  });

  it('AC-014-5: isLocalRemoteUrl пропускает только путь remote под /mf/', () => {
    expect(isLocalRemoteUrl('/mf/admin/remoteEntry.json')).toBe(true);
    expect(isLocalRemoteUrl('https://evil.example/remoteEntry.json')).toBe(false);
    expect(isLocalRemoteUrl('//evil.example/remoteEntry.json')).toBe(false);
    expect(isLocalRemoteUrl('/mf/../x/remoteEntry.json')).toBe(false);
    expect(isLocalRemoteUrl('/mf/%2e%2e/remoteEntry.json')).toBe(false);
    expect(isLocalRemoteUrl('/mf/a\\b/remoteEntry.json')).toBe(false);
    expect(isLocalRemoteUrl('/mf/admin/main.js')).toBe(false);
    expect(isLocalRemoteUrl('javascript:alert(1)')).toBe(false);
  });

  it('AC-014-6: safeReturnTo пропускает только путь приложения', () => {
    expect(safeReturnTo('/swarms/x?a=1')).toBe('/swarms/x?a=1');
    expect(safeReturnTo(null)).toBe('/');
    expect(safeReturnTo('https://evil.example')).toBe('/');
    expect(safeReturnTo('//evil.example')).toBe('/');
    expect(safeReturnTo('/\\evil')).toBe('/');
    expect(safeReturnTo('swarms')).toBe('/');
    expect(safeReturnTo('/a\tb')).toBe('/');
  });
});
