import { describe, expect, it } from 'vitest';
import {
  ROLE_PERMISSIONS,
  InvitationAcceptRequest,
  InvitationRequest,
  Permission,
  TokenRevocationList,
  UserUpdate,
  actorFromClaims,
  can,
  type AccessTokenClaims,
  type Role,
} from '../src/index.ts';

const USER_ID = '0b6f6d2e-6a4c-4c3e-9f5e-111111111111';
const ORG_ID = '0b6f6d2e-6a4c-4c3e-9f5e-222222222222';

const claims = (role: Role): AccessTokenClaims => ({
  sub: USER_ID,
  org: role === 'supervisor' ? null : ORG_ID,
  role,
  iss: 'swag-identity',
  aud: 'swag',
  iat: 1_800_000_000,
  exp: 1_800_000_900,
});

const EXPECTED: Record<Role, Permission[]> = {
  user: ['swarm.create', 'swarm.read', 'swarm.stop', 'balance.read'],
  admin: [
    'swarm.create',
    'swarm.read',
    'swarm.stop',
    'user.manage',
    'balance.read',
    'balance.topup',
  ],
  supervisor: [
    'swarm.read',
    'swarm.stop',
    'user.manage',
    'organization.read',
    'balance.read',
    'balance.topup',
  ],
};

const ALL_PERMISSIONS = Permission.options;

describe('права и вызывающий', () => {
  it('AC-024-1: actorFromClaims для каждой роли берёт userId из sub, orgId из org и права из таблицы', () => {
    for (const role of ['user', 'admin', 'supervisor'] as const) {
      const actor = actorFromClaims(claims(role));
      expect(actor).toEqual({
        userId: USER_ID,
        orgId: role === 'supervisor' ? null : ORG_ID,
        role,
        permissions: EXPECTED[role],
      });
      expect(actor.permissions).toEqual(ROLE_PERMISSIONS[role]);
    }
  });

  it('AC-024-1: can совпадает с таблицей прав для каждого права и роли', () => {
    for (const role of ['user', 'admin', 'supervisor'] as const) {
      const actor = actorFromClaims(claims(role));
      for (const permission of ALL_PERMISSIONS) {
        expect(can(actor, permission)).toBe(EXPECTED[role].includes(permission));
      }
    }
  });

  it('AC-024-1: у supervisor нет swarm.create', () => {
    expect(can(actorFromClaims(claims('supervisor')), 'swarm.create')).toBe(false);
  });

  it('AC-013-22: user видит баланс без пополнения; admin и supervisor — оба права', () => {
    const user = actorFromClaims(claims('user'));
    expect(can(user, 'balance.read')).toBe(true);
    expect(can(user, 'balance.topup')).toBe(false);
    for (const role of ['admin', 'supervisor'] as const) {
      const actor = actorFromClaims(claims(role));
      expect(can(actor, 'balance.read')).toBe(true);
      expect(can(actor, 'balance.topup')).toBe(true);
    }
  });
});

describe('схемы управления пользователями', () => {
  it('REQ-024-7: UserUpdate без полей не проходит, с одним полем проходит', () => {
    expect(UserUpdate.safeParse({}).success).toBe(false);
    expect(UserUpdate.safeParse({ role: 'admin' }).success).toBe(true);
    expect(UserUpdate.safeParse({ blocked: false }).success).toBe(true);
  });

  it('REQ-024-7: UserUpdate не выдаёт роль supervisor', () => {
    expect(UserUpdate.safeParse({ role: 'supervisor' }).success).toBe(false);
  });

  it('REQ-024-6: InvitationRequest принимает user и admin, отклоняет supervisor', () => {
    expect(InvitationRequest.safeParse({ email: 'a@b.co', role: 'user' }).success).toBe(true);
    expect(InvitationRequest.safeParse({ email: 'a@b.co', role: 'admin' }).success).toBe(true);
    expect(InvitationRequest.safeParse({ email: 'a@b.co', role: 'supervisor' }).success).toBe(
      false,
    );
  });

  it('REQ-024-6: InvitationAcceptRequest требует токен и пароль от 10 символов', () => {
    expect(
      InvitationAcceptRequest.safeParse({ token: 'x'.repeat(40), password: 'a'.repeat(10) })
        .success,
    ).toBe(true);
    expect(InvitationAcceptRequest.safeParse({ token: '', password: 'a'.repeat(10) }).success).toBe(
      false,
    );
    expect(InvitationAcceptRequest.safeParse({ token: 'x', password: 'a'.repeat(9) }).success).toBe(
      false,
    );
  });

  it('REQ-024-9: TokenRevocationList принимает записи и отклоняет неверный userId', () => {
    const valid = {
      revocations: [{ userId: USER_ID, validAfter: 1_800_000_000_000, blocked: true }],
    };
    expect(TokenRevocationList.safeParse(valid).success).toBe(true);
    expect(
      TokenRevocationList.safeParse({
        revocations: [{ userId: 'не-uuid', validAfter: 1, blocked: false }],
      }).success,
    ).toBe(false);
  });
});
