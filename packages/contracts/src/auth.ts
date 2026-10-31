import { z } from 'zod';

// Спека 012, 4.1. Регистрация, вход, токены и ошибки identity.
export const UserId = z.uuid();
export const OrgId = z.uuid();
export const Role = z.enum(['user', 'admin', 'supervisor']); // Q-8
export type Role = z.infer<typeof Role>;

export const Email = z.string().trim().toLowerCase().pipe(z.email().max(254));
export const Password = z.string().min(10).max(128); // Q-10; без trim
export const OrganizationName = z.string().trim().min(1).max(200);

export const RegistrationRequest = z.object({ email: Email });
export type RegistrationRequest = z.infer<typeof RegistrationRequest>;

export const RegistrationConfirmRequest = z.object({
  token: z.string().min(1).max(200),
  password: Password,
  organizationName: OrganizationName, // Q-5
});
export type RegistrationConfirmRequest = z.infer<typeof RegistrationConfirmRequest>;

export const LoginRequest = z.object({ email: Email, password: z.string().min(1).max(128) });
export type LoginRequest = z.infer<typeof LoginRequest>;

export const AccessTokenClaims = z.object({
  sub: UserId,
  org: OrgId.nullable(), // null только у supervisor
  role: Role,
  iss: z.literal('swag-identity'),
  aud: z.literal('swag'),
  iat: z.number().int(),
  exp: z.number().int(),
});
export type AccessTokenClaims = z.infer<typeof AccessTokenClaims>;

export const AuthUser = z.object({
  id: UserId,
  email: z.string(),
  role: Role,
  orgId: OrgId.nullable(),
});
export type AuthUser = z.infer<typeof AuthUser>;
export const AuthOrganization = z.object({ id: OrgId, name: z.string() });
export type AuthOrganization = z.infer<typeof AuthOrganization>;

export const AuthSession = z.object({
  accessToken: z.string(),
  expiresIn: z.number().int(), // секунды, = IDENTITY_ACCESS_TTL_S
  user: AuthUser,
  organization: AuthOrganization.nullable(), // null у supervisor
});
export type AuthSession = z.infer<typeof AuthSession>;
export const AuthRefreshed = AuthSession.pick({ accessToken: true, expiresIn: true });
export type AuthRefreshed = z.infer<typeof AuthRefreshed>;
export const AuthMe = AuthSession.pick({ user: true, organization: true });
export type AuthMe = z.infer<typeof AuthMe>;

export const AuthErrorCode = z.enum([
  'validation_error',
  'invalid_token',
  'email_taken',
  'invalid_credentials',
  'invalid_refresh_token',
  'unauthorized',
  'rate_limited',
  'mail_unavailable',
  'internal_error',
  'forbidden', // 024, 4.2
  'not_found',
  'user_blocked',
]);
export type AuthErrorCode = z.infer<typeof AuthErrorCode>;

// Спека 024, 4.2. Управление пользователями и организациями.
export const OrgRole = z.enum(['user', 'admin']); // роль, которую можно выдать через API
export type OrgRole = z.infer<typeof OrgRole>;

export const ManagedUser = z.object({
  id: UserId,
  email: z.string(),
  role: Role,
  orgId: OrgId.nullable(),
  blocked: z.boolean(),
  createdAt: z.iso.datetime(),
});
export type ManagedUser = z.infer<typeof ManagedUser>;
export const UserList = z.object({ users: z.array(ManagedUser) }); // по email, по возрастанию
export type UserList = z.infer<typeof UserList>;

export const InvitationRequest = z.object({ email: Email, role: OrgRole });
export type InvitationRequest = z.infer<typeof InvitationRequest>;
export const InvitationAcceptRequest = z.object({
  token: z.string().min(1).max(200),
  password: Password,
});
export type InvitationAcceptRequest = z.infer<typeof InvitationAcceptRequest>;

export const UserUpdate = z
  .object({ role: OrgRole.optional(), blocked: z.boolean().optional() })
  .refine((u) => u.role !== undefined || u.blocked !== undefined);
export type UserUpdate = z.infer<typeof UserUpdate>;

export const OrganizationSummary = z.object({
  id: OrgId,
  name: z.string(),
  createdAt: z.iso.datetime(),
  userCount: z.number().int(),
});
export type OrganizationSummary = z.infer<typeof OrganizationSummary>;
export const OrganizationList = z.object({ organizations: z.array(OrganizationSummary) }); // по name
export type OrganizationList = z.infer<typeof OrganizationList>;

export const TokenRevocation = z.object({
  userId: UserId,
  validAfter: z.number().int(), // мс эпохи: токен с iat * 1000 < validAfter недействителен
  blocked: z.boolean(),
});
export type TokenRevocation = z.infer<typeof TokenRevocation>;
export const TokenRevocationList = z.object({ revocations: z.array(TokenRevocation) });
export type TokenRevocationList = z.infer<typeof TokenRevocationList>;
