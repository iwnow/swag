import { z } from 'zod';
import { type AccessTokenClaims, type Role } from './auth.ts';

// Спека 024, 4.1. Права и вызывающий. Права — что можно делать; чьи данные видны, решает область по роли (024, 4.4).
export const Permission = z.enum([
  'swarm.create',
  'swarm.read',
  'swarm.stop',
  'user.manage',
  'organization.read',
  'balance.read',
  'balance.topup',
  'node.read', // 021, 4.6: каталог типов узлов
  'secret.manage', // 026, 4.6: секреты организации
]);
export type Permission = z.infer<typeof Permission>;

export const ROLE_PERMISSIONS: Record<Role, readonly Permission[]> = {
  user: ['swarm.create', 'swarm.read', 'swarm.stop', 'balance.read', 'node.read'],
  admin: [
    'swarm.create',
    'swarm.read',
    'swarm.stop',
    'user.manage',
    'balance.read',
    'balance.topup',
    'node.read',
    'secret.manage',
  ],
  supervisor: [
    'swarm.read',
    'swarm.stop',
    'user.manage',
    'organization.read',
    'balance.read',
    'balance.topup',
    'node.read',
  ], // Q-4: роёв не создаёт
};

export type Actor = {
  userId: string;
  orgId: string | null; // null только у supervisor
  role: Role;
  permissions: readonly Permission[];
};

export function actorFromClaims(claims: AccessTokenClaims): Actor {
  return {
    userId: claims.sub,
    orgId: claims.org,
    role: claims.role,
    permissions: ROLE_PERMISSIONS[claims.role],
  };
}

export function can(actor: Actor, permission: Permission): boolean {
  return actor.permissions.includes(permission);
}
