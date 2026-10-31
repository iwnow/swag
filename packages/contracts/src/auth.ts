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
]);
export type AuthErrorCode = z.infer<typeof AuthErrorCode>;
