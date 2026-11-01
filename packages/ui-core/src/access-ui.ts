import { z } from 'zod';
import {
  can,
  ROLE_PERMISSIONS,
  type Actor,
  type AuthMe,
  type ManagedUser,
  type UserUpdate,
} from '@swag/contracts';

// Спека 014, 4.2: доступ к разделам, действия над пользователями, проверка адресов. Чистые функции.

export const UiArea = z.enum(['swarms', 'balance', 'admin', 'supervisor']);
export type UiArea = z.infer<typeof UiArea>;
export type NavItem = { area: UiArea; label: string; path: string };

const NAV: readonly NavItem[] = [
  { area: 'swarms', label: 'Рои', path: '/' },
  { area: 'balance', label: 'Баланс', path: '/balance' },
  { area: 'admin', label: 'Админка', path: '/admin/users' },
  { area: 'supervisor', label: 'Организации', path: '/supervisor' },
];

function actorOf(me: AuthMe): Actor {
  return {
    userId: me.user.id,
    orgId: me.user.orgId,
    role: me.user.role,
    permissions: ROLE_PERMISSIONS[me.user.role],
  };
}

export function canOpen(area: UiArea, me: AuthMe | null): boolean {
  if (me === null) return false;
  const actor = actorOf(me);
  switch (area) {
    case 'swarms':
      return can(actor, 'swarm.read');
    case 'balance':
      return can(actor, 'balance.read') && me.organization !== null;
    case 'admin':
      return can(actor, 'user.manage') && me.user.role === 'admin';
    case 'supervisor':
      return can(actor, 'organization.read');
  }
}

export function navigationFor(me: AuthMe | null): NavItem[] {
  return NAV.filter((item) => canOpen(item.area, me));
}

export type UserAction = 'make_admin' | 'make_user' | 'block' | 'unblock';

// Трактовка: зеркалит PATCH /auth/users/:id (024, 4.7); решение о доступе остаётся в identity.
export function userActions(me: AuthMe, target: ManagedUser): UserAction[] {
  if (target.id === me.user.id || target.role === 'supervisor') return [];
  if (!can(actorOf(me), 'user.manage')) return [];
  if (me.user.role === 'admin' && target.orgId !== me.organization?.id) return [];
  const actions: UserAction[] = [];
  if (target.role === 'user') actions.push('make_admin');
  if (target.role === 'admin') actions.push('make_user');
  actions.push(target.blocked ? 'unblock' : 'block');
  return actions;
}

export interface UserRow {
  user: ManagedUser;
  actions: UserAction[];
}

// Строки таблиц админки и супервизора: действия считаются от текущего `AuthMe` (null — без действий).
export function userRows(me: AuthMe | null, users: ManagedUser[]): UserRow[] {
  return users.map((user) => ({ user, actions: me ? userActions(me, user) : [] }));
}

export function userActionBody(action: UserAction): UserUpdate {
  switch (action) {
    case 'make_admin':
      return { role: 'admin' };
    case 'make_user':
      return { role: 'user' };
    case 'block':
      return { blocked: true };
    case 'unblock':
      return { blocked: false };
  }
}

function hasControlChar(value: string): boolean {
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

// Трактовка: адрес — только путь приложения; протокол-относительные и обратные слеши отклоняются.
export function safeReturnTo(value: string | null): string {
  if (value === null || !value.startsWith('/')) return '/';
  if (value.includes('//') || value.includes('\\') || hasControlChar(value)) return '/';
  return value;
}

export function isLocalRemoteUrl(url: string): boolean {
  if (!url.startsWith('/mf/') || !url.endsWith('/remoteEntry.json')) return false;
  if (url.includes('//') || url.includes('\\') || url.includes('%')) return false;
  return !url.split('/').some((segment) => segment === '.' || segment === '..');
}
