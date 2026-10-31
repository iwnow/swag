import {
  LoginRequest,
  RegistrationConfirmRequest,
  RegistrationRequest,
  actorFromClaims,
  can,
  type AccessTokenClaims,
  type Actor,
  type AuthErrorCode,
  type AuthMe,
  type AuthUser,
  type AuthRefreshed,
  type AuthSession,
  type ManagedUser,
  type OrganizationList,
  type OrganizationSummary,
  type OrgRole,
  type Role,
  type ServiceInfo,
  type TokenRevocationList,
  type UserList,
  UserUpdate,
  InvitationAcceptRequest,
  InvitationRequest,
} from '@swag/contracts';
import type { z } from 'zod';

// Спека 012, 4.2–4.3, 4.6, 4.8. Порты объявляет ядро; адаптеры передаёт оболочка.

export interface Clock {
  now(): number; // мс эпохи
}
export interface IdGenerator {
  uuid(): string;
}
export type LogContext = {
  userId?: string;
  err?: unknown;
  [key: string]: unknown;
};
export interface Logger {
  debug(msg: string, ctx?: LogContext): void;
  info(msg: string, ctx?: LogContext): void;
  warn(msg: string, ctx?: LogContext): void;
  error(msg: string, ctx?: LogContext): void;
}

export type StoredUser = {
  id: string;
  email: string;
  passwordHash: string;
  role: Role;
  orgId: string | null;
  createdAt: number;
  blockedAt: number | null;
  tokensValidAfter: number | null;
};
export type StoredOrganization = { id: string; name: string; createdAt: number };

export interface IdentityStore {
  findUserByEmail(email: string): Promise<StoredUser | null>;
  findUserById(
    id: string,
  ): Promise<{ user: StoredUser; organization: StoredOrganization | null } | null>;
  hasSupervisor(): Promise<boolean>;
  createUser(user: StoredUser): Promise<void>; // нарушение уникальности email — reject
  addConfirmation(c: {
    tokenHash: string;
    email: string;
    expiresAt: number;
    createdAt: number;
  }): Promise<void>;
  confirmRegistration(input: {
    tokenHash: string;
    now: number;
    org: StoredOrganization;
    user: Omit<StoredUser, 'email'>;
  }): Promise<
    { status: 'ok'; email: string } | { status: 'invalid_token' } | { status: 'email_taken' }
  >;
  createSession(s: {
    id: string;
    userId: string;
    refreshHash: string;
    expiresAt: number;
    createdAt: number;
  }): Promise<void>;
  rotateSession(input: {
    oldHash: string;
    newHash: string;
    now: number;
    expiresAt: number;
  }): Promise<
    { status: 'ok'; userId: string } | { status: 'reused'; userId: string } | { status: 'invalid' }
  >;
  revokeSession(refreshHash: string, now: number): Promise<void>;
  // Спека 024, 4.9:
  listUsers(filter: { orgId?: string }): Promise<StoredUser[]>; // по email
  updateUser(input: {
    id: string;
    role?: Role;
    blockedAt?: number | null;
    revokeAt?: number;
  }): Promise<StoredUser>;
  addInvitation(i: {
    tokenHash: string;
    email: string;
    orgId: string;
    role: OrgRole;
    invitedBy: string;
    expiresAt: number;
    createdAt: number;
  }): Promise<void>;
  acceptInvitation(input: {
    tokenHash: string;
    now: number;
    user: { id: string; passwordHash: string; createdAt: number };
  }): Promise<
    | { status: 'ok'; user: StoredUser; organization: StoredOrganization }
    | { status: 'invalid_token' }
    | { status: 'email_taken' }
  >;
  listOrganizations(): Promise<(StoredOrganization & { userCount: number })[]>; // по name
  tokenRevocations(
    since: number,
  ): Promise<{ userId: string; validAfter: number; blocked: boolean }[]>; // tokens_valid_after > since
  purge(before: number): Promise<{ confirmations: number; invitations: number; sessions: number }>;
}

export interface PasswordHasher {
  hash(password: string): Promise<string>; // PHC-строка хэша (алгоритм задаёт адаптер)
  verify(hash: string, password: string): Promise<boolean>; // false и на битую строку хэша
}

export interface OpaqueTokens {
  create(): { token: string; hash: string }; // 32 байта случайности base64url (43 символа); hash = SHA-256 hex
  hash(token: string): string;
}

export interface TokenSigner {
  sign(claims: AccessTokenClaims): Promise<string>;
}
export interface TokenVerifier {
  verify(token: string): Promise<AccessTokenClaims | null>; // null — любой отказ
}

export type MailMessage = { to: string; subject: string; text: string };
export interface Mailer {
  send(message: MailMessage): Promise<void>; // reject — не отправлено
}

export interface RateLimiter {
  hit(key: string, limit: number, windowMs: number): Promise<boolean>; // true — разрешено, попытка засчитана
}

export interface IdentityCoreDeps {
  version: string;
  store: IdentityStore;
  hasher: PasswordHasher;
  opaque: OpaqueTokens;
  signer: TokenSigner;
  verifier: TokenVerifier;
  mailer: Mailer;
  limiter: RateLimiter;
  clock: Clock;
  ids: IdGenerator;
  log: Logger;
  settings: {
    confirmUrl: string; // IDENTITY_CONFIRM_URL
    accessTtlS: number;
    refreshTtlS: number;
    confirmTtlS: number;
    inviteUrl: string; // IDENTITY_INVITE_URL
    inviteTtlS: number; // IDENTITY_INVITE_TTL_S
    supervisor: { email: string; password: string } | null;
  };
}

export interface RequestMeta {
  ip: string; // ключ лимитов 4.8; оболочка берёт request.ip
}

export type IssuedSession = { session: AuthSession; refreshToken: string }; // refreshToken оболочка кладёт в cookie, в тело не попадает

export interface IdentityError {
  code: AuthErrorCode;
  message: string;
  issues?: { path: string; message: string }[];
}
export type Result<T> = { ok: true; value: T } | { ok: false; error: IdentityError };

export interface IdentityCore {
  info(): ServiceInfo;
  requestRegistration(body: unknown, meta: RequestMeta): Promise<Result<void>>;
  confirmRegistration(body: unknown, meta: RequestMeta): Promise<Result<IssuedSession>>;
  login(body: unknown, meta: RequestMeta): Promise<Result<IssuedSession>>;
  refresh(
    refreshToken: string | undefined,
  ): Promise<Result<{ refreshed: AuthRefreshed; refreshToken: string }>>;
  logout(refreshToken: string | undefined): Promise<Result<void>>; // нет или неизвестен — тоже ok
  me(accessToken: string | undefined): Promise<Result<AuthMe>>;
  listUsers(accessToken: string | undefined, query: { orgId?: string }): Promise<Result<UserList>>;
  listOrganizations(accessToken: string | undefined): Promise<Result<OrganizationList>>;
  inviteUser(accessToken: string | undefined, body: unknown): Promise<Result<void>>;
  acceptInvitation(body: unknown, meta: RequestMeta): Promise<Result<IssuedSession>>;
  updateUser(
    accessToken: string | undefined,
    userId: string,
    body: unknown,
  ): Promise<Result<ManagedUser>>;
  tokenRevocations(): Promise<TokenRevocationList>; // проверку внутреннего токена делает оболочка
  purgeExpired(): Promise<void>;
  ensureSupervisor(): Promise<void>; // бросает при занятом email (REQ-012-15); вызывает оболочка до listen
}

export const CONFIRM_MAIL_SUBJECT = 'Подтвердите регистрацию в Swag';
export const ALREADY_REGISTERED_MAIL_SUBJECT = 'Вы уже зарегистрированы в Swag';
export const ALREADY_REGISTERED_MAIL_TEXT =
  'На этот адрес уже есть аккаунт. Войдите по своему паролю. Если это были не вы, ничего не делайте.';
export const confirmMailText = (link: string, ttlHours: number): string =>
  `Чтобы закончить регистрацию компании, откройте ссылку: ${link}\nСсылка действует ${ttlHours} ч. Если вы не регистрировались, ничего не делайте.`;
export const INVITATION_MAIL_SUBJECT = 'Приглашение в Swag';
export const invitationMailText = (orgName: string, link: string, ttlHours: number): string =>
  `Вас пригласили в организацию «${orgName}» в Swag. Чтобы задать пароль и войти, откройте ссылку: ${link} Ссылка действует ${ttlHours} ч.`;

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;

// Спека 024, 4.9 (Q-11): срок хранения просроченных и закрытых записей до уборки purge.
export const RETENTION_MS = 7 * 24 * HOUR_MS;

export const RATE_LIMITS = {
  registerEmail: { key: 'register:email', limit: 3, windowMs: HOUR_MS },
  registerIp: { key: 'register:ip', limit: 10, windowMs: HOUR_MS },
  confirmIp: { key: 'confirm:ip', limit: 20, windowMs: HOUR_MS },
  loginEmail: { key: 'login:email', limit: 10, windowMs: 15 * MINUTE_MS },
  loginIp: { key: 'login:ip', limit: 30, windowMs: 15 * MINUTE_MS },
  inviteUser: { key: 'invite:user', limit: 20, windowMs: HOUR_MS },
} as const;

type RateRule = { readonly key: string; readonly limit: number; readonly windowMs: number };

const MESSAGES: Record<AuthErrorCode, string> = {
  validation_error: 'invalid request',
  invalid_token: 'invalid or expired token',
  email_taken: 'email already registered',
  invalid_credentials: 'invalid email or password',
  invalid_refresh_token: 'invalid refresh token',
  unauthorized: 'unauthorized',
  rate_limited: 'too many requests',
  mail_unavailable: 'mail unavailable',
  internal_error: 'internal error',
  forbidden: 'forbidden',
  not_found: 'not found',
  user_blocked: 'user blocked',
};

// Спека 024, 4.8: маппинг хранилища в ответы API. Пароль и хэш сюда не попадают.
const managedUser = (user: StoredUser): ManagedUser => ({
  id: user.id,
  email: user.email,
  role: user.role,
  orgId: user.orgId,
  blocked: user.blockedAt !== null,
  createdAt: new Date(user.createdAt).toISOString(),
});
const organizationSummary = (
  organization: StoredOrganization & { userCount: number },
): OrganizationSummary => ({
  id: organization.id,
  name: organization.name,
  createdAt: new Date(organization.createdAt).toISOString(),
  userCount: organization.userCount,
});

const ok = <T>(value: T): Result<T> => ({ ok: true, value });
const fail = <T>(code: AuthErrorCode, issues?: IdentityError['issues']): Result<T> => ({
  ok: false,
  error:
    issues === undefined
      ? { code, message: MESSAGES[code] }
      : { code, message: MESSAGES[code], issues },
});

export function createIdentityCore(deps: IdentityCoreDeps): IdentityCore {
  const { store, clock, log, limiter, mailer, opaque, settings, hasher, signer, verifier, ids } =
    deps;

  const parse = <S extends z.ZodType>(schema: S, body: unknown): Result<z.output<S>> => {
    const parsed = schema.safeParse(body);
    if (parsed.success) return ok(parsed.data);
    return fail(
      'validation_error',
      parsed.error.issues.map((issue) => ({
        path: issue.path.map(String).join('.'),
        message: issue.message,
      })),
    );
  };

  // Засчитывает попытку; true — лимит исчерпан. Ключ с email в лог не попадает.
  const exceeded = async (rule: RateRule, id: string): Promise<boolean> => {
    if (await limiter.hit(`${rule.key}:${id}`, rule.limit, rule.windowMs)) return false;
    log.warn('rate_limited', { limit: rule.key });
    return true;
  };

  // Адрес и текст ошибки почты в лог не пишем: текст ошибки может содержать адрес.
  const sendMail = async (message: MailMessage): Promise<boolean> => {
    try {
      await mailer.send(message);
      return true;
    } catch {
      log.error('mail_send_failed');
      return false;
    }
  };

  // Токен подтверждения: в хранилище только хэш, в письме — сырой токен.
  // D-113 (вариант б): срок в часах округляется вверх.
  const sendConfirmation = async (email: string, now: number): Promise<boolean> => {
    const { token, hash } = opaque.create();
    await store.addConfirmation({
      tokenHash: hash,
      email,
      expiresAt: now + settings.confirmTtlS * 1000,
      createdAt: now,
    });
    const link = `${settings.confirmUrl}?token=${token}`;
    return sendMail({
      to: email,
      subject: CONFIRM_MAIL_SUBJECT,
      text: confirmMailText(link, Math.ceil(settings.confirmTtlS / 3600)),
    });
  };

  const sendAlreadyRegistered = (email: string): Promise<boolean> =>
    sendMail({
      to: email,
      subject: ALREADY_REGISTERED_MAIL_SUBJECT,
      text: ALREADY_REGISTERED_MAIL_TEXT,
    });

  const requestRegistration = async (body: unknown, meta: RequestMeta): Promise<Result<void>> => {
    const parsed = parse(RegistrationRequest, body);
    if (!parsed.ok) return parsed;
    const { email } = parsed.value;
    if (
      (await exceeded(RATE_LIMITS.registerIp, meta.ip)) ||
      (await exceeded(RATE_LIMITS.registerEmail, email))
    ) {
      return fail('rate_limited');
    }
    const existing = await store.findUserByEmail(email);
    const sent = existing
      ? await sendAlreadyRegistered(email)
      : await sendConfirmation(email, clock.now());
    return sent ? ok(undefined) : fail('mail_unavailable');
  };

  const authUser = (user: StoredUser): AuthUser => ({
    id: user.id,
    email: user.email,
    role: user.role,
    orgId: user.orgId,
  });
  const authOrganization = (organization: StoredOrganization | null) =>
    organization ? { id: organization.id, name: organization.name } : null;

  const signAccessToken = (user: StoredUser, now: number): Promise<string> => {
    const iat = Math.floor(now / 1000);
    return signer.sign({
      sub: user.id,
      org: user.orgId,
      role: user.role,
      iss: 'swag-identity',
      aud: 'swag',
      iat,
      exp: iat + settings.accessTtlS,
    });
  };

  // Выдаёт токен доступа и токен обновления; токен обновления в хранилище — только хэш.
  const issueSession = async (
    user: StoredUser,
    organization: StoredOrganization | null,
  ): Promise<IssuedSession> => {
    const now = clock.now();
    const { token, hash } = opaque.create();
    await store.createSession({
      id: ids.uuid(),
      userId: user.id,
      refreshHash: hash,
      expiresAt: now + settings.refreshTtlS * 1000,
      createdAt: now,
    });
    return {
      session: {
        accessToken: await signAccessToken(user, now),
        expiresIn: settings.accessTtlS,
        user: authUser(user),
        organization: authOrganization(organization),
      },
      refreshToken: token,
    };
  };

  const confirmRegistration = async (
    body: unknown,
    meta: RequestMeta,
  ): Promise<Result<IssuedSession>> => {
    const parsed = parse(RegistrationConfirmRequest, body);
    if (!parsed.ok) return parsed;
    const { token, password, organizationName } = parsed.value;
    if (await exceeded(RATE_LIMITS.confirmIp, meta.ip)) return fail('rate_limited');
    const now = clock.now();
    const passwordHash = await hasher.hash(password);
    const org: StoredOrganization = { id: ids.uuid(), name: organizationName, createdAt: now };
    const userId = ids.uuid();
    const result = await store.confirmRegistration({
      tokenHash: opaque.hash(token),
      now,
      org,
      user: {
        id: userId,
        passwordHash,
        role: 'admin',
        orgId: org.id,
        createdAt: now,
        blockedAt: null,
        tokensValidAfter: null,
      },
    });
    if (result.status === 'invalid_token') {
      log.warn('confirm_invalid_token');
      return fail('invalid_token');
    }
    if (result.status === 'email_taken') return fail('email_taken');
    const user: StoredUser = {
      id: userId,
      email: result.email,
      passwordHash,
      role: 'admin',
      orgId: org.id,
      createdAt: now,
      blockedAt: null,
      tokensValidAfter: null,
    };
    return ok(await issueSession(user, org));
  };

  const refresh = async (
    refreshToken: string | undefined,
  ): Promise<Result<{ refreshed: AuthRefreshed; refreshToken: string }>> => {
    if (refreshToken === undefined) return fail('invalid_refresh_token');
    const now = clock.now();
    const { token, hash } = opaque.create();
    const rotated = await store.rotateSession({
      oldHash: opaque.hash(refreshToken),
      newHash: hash,
      now,
      expiresAt: now + settings.refreshTtlS * 1000,
    });
    if (rotated.status === 'reused') {
      log.warn('refresh_reuse_detected', { userId: rotated.userId });
      return fail('invalid_refresh_token');
    }
    if (rotated.status === 'invalid') return fail('invalid_refresh_token');
    const found = await store.findUserById(rotated.userId);
    if (!found || found.user.blockedAt !== null) return fail('invalid_refresh_token');
    const accessToken = await signAccessToken(found.user, now);
    return ok({ refreshed: { accessToken, expiresIn: settings.accessTtlS }, refreshToken: token });
  };

  // Нет токена или он неизвестен — тоже ok: выход идемпотентен.
  const logout = async (refreshToken: string | undefined): Promise<Result<void>> => {
    if (refreshToken !== undefined) {
      await store.revokeSession(opaque.hash(refreshToken), clock.now());
    }
    return ok(undefined);
  };

  // Первый супервизор из настроек. Занятый email другой ролью — ошибка старта, роль молча не меняется.
  const ensureSupervisor = async (): Promise<void> => {
    const supervisor = settings.supervisor;
    if (supervisor === null || (await store.hasSupervisor())) return;
    if (await store.findUserByEmail(supervisor.email)) {
      throw new Error('supervisor email taken');
    }
    const userId = ids.uuid();
    await store.createUser({
      id: userId,
      email: supervisor.email,
      passwordHash: await hasher.hash(supervisor.password),
      role: 'supervisor',
      orgId: null,
      createdAt: clock.now(),
      blockedAt: null,
      tokensValidAfter: null,
    });
    log.info('supervisor_created', { userId });
  };

  // Хэш от случайной строки: на несуществующий email хэшер всё равно работает столько же, сколько на существующий.
  let dummyHash: Promise<string> | undefined;
  // Отклонённый промис не кешируем: следующий вход снова попробует посчитать хэш.
  const getDummyHash = (): Promise<string> => {
    dummyHash ??= hasher.hash(opaque.create().token).catch((err: unknown) => {
      dummyHash = undefined;
      throw err;
    });
    return dummyHash;
  };

  const login = async (body: unknown, meta: RequestMeta): Promise<Result<IssuedSession>> => {
    const parsed = parse(LoginRequest, body);
    if (!parsed.ok) return parsed;
    const { email, password } = parsed.value;
    if (
      (await exceeded(RATE_LIMITS.loginIp, meta.ip)) ||
      (await exceeded(RATE_LIMITS.loginEmail, email))
    ) {
      return fail('rate_limited');
    }
    const user = await store.findUserByEmail(email);
    const valid = await hasher.verify(user?.passwordHash ?? (await getDummyHash()), password);
    if (!user || !valid) {
      log.warn('login_failed', user ? { userId: user.id } : {});
      return fail('invalid_credentials');
    }
    if (user.blockedAt !== null) {
      log.warn('login_blocked', { userId: user.id });
      return fail('user_blocked');
    }
    const found = await store.findUserById(user.id);
    return ok(await issueSession(user, found?.organization ?? null));
  };

  // Внутренняя: проверка токена доступа и отзыва (спека 024, 4.8). Роль и организация — из хранилища, не из токена.
  const authenticate = async (
    accessToken: string | undefined,
  ): Promise<
    Result<{ actor: Actor; user: StoredUser; organization: StoredOrganization | null }>
  > => {
    const claims = accessToken === undefined ? null : await verifier.verify(accessToken);
    if (!claims) return fail('unauthorized');
    const found = await store.findUserById(claims.sub);
    if (!found) return fail('unauthorized');
    const { user, organization } = found;
    const revoked = user.tokensValidAfter !== null && claims.iat * 1000 < user.tokensValidAfter;
    if (user.blockedAt !== null || revoked) return fail('unauthorized');
    const actor = actorFromClaims({ ...claims, org: user.orgId, role: user.role });
    return ok({ actor, user, organization });
  };

  const me = async (accessToken: string | undefined): Promise<Result<AuthMe>> => {
    const auth = await authenticate(accessToken);
    if (!auth.ok) return auth;
    const { user, organization } = auth.value;
    return ok({ user: authUser(user), organization: authOrganization(organization) });
  };

  // admin — только своя организация, query.orgId игнорируется; supervisor — все или orgId (4.7).
  const listUsers = async (
    accessToken: string | undefined,
    query: { orgId?: string },
  ): Promise<Result<UserList>> => {
    const auth = await authenticate(accessToken);
    if (!auth.ok) return auth;
    const { actor } = auth.value;
    if (!can(actor, 'user.manage')) return fail('forbidden');
    const orgId = actor.role === 'supervisor' ? query.orgId : actor.orgId;
    // admin без организации контракт не допускает; без фильтра такой вызов показал бы всех.
    if (orgId === null) return fail('forbidden');
    const users = await store.listUsers(orgId === undefined ? {} : { orgId });
    return ok({ users: users.map(managedUser) });
  };

  const listOrganizations = async (
    accessToken: string | undefined,
  ): Promise<Result<OrganizationList>> => {
    const auth = await authenticate(accessToken);
    if (!auth.ok) return auth;
    if (!can(auth.value.actor, 'organization.read')) return fail('forbidden');
    const organizations = await store.listOrganizations();
    return ok({ organizations: organizations.map(organizationSummary) });
  };

  // Спека 024, 4.8 и 4.10: приглашение создаёт пользователя в организации администратора.
  const inviteUser = async (
    accessToken: string | undefined,
    body: unknown,
  ): Promise<Result<void>> => {
    const auth = await authenticate(accessToken);
    if (!auth.ok) return auth;
    const { actor, organization } = auth.value;
    if (actor.role !== 'admin' || actor.orgId === null || organization === null) {
      return fail('forbidden');
    }
    const parsed = parse(InvitationRequest, body);
    if (!parsed.ok) return parsed;
    const { email, role } = parsed.value;
    if (await exceeded(RATE_LIMITS.inviteUser, actor.userId)) return fail('rate_limited');
    if (await store.findUserByEmail(email)) {
      return (await sendAlreadyRegistered(email)) ? ok(undefined) : fail('mail_unavailable');
    }
    const now = clock.now();
    const { token, hash } = opaque.create();
    await store.addInvitation({
      tokenHash: hash,
      email,
      orgId: actor.orgId,
      role,
      invitedBy: actor.userId,
      expiresAt: now + settings.inviteTtlS * 1000,
      createdAt: now,
    });
    const link = `${settings.inviteUrl}?token=${token}`;
    const sent = await sendMail({
      to: email,
      subject: INVITATION_MAIL_SUBJECT,
      text: invitationMailText(organization.name, link, Math.ceil(settings.inviteTtlS / 3600)),
    });
    if (!sent) return fail('mail_unavailable');
    log.info('user_invited', { userId: actor.userId, orgId: actor.orgId });
    return ok(undefined);
  };

  const acceptInvitation = async (
    body: unknown,
    meta: RequestMeta,
  ): Promise<Result<IssuedSession>> => {
    const parsed = parse(InvitationAcceptRequest, body);
    if (!parsed.ok) return parsed;
    const { token, password } = parsed.value;
    if (await exceeded(RATE_LIMITS.confirmIp, meta.ip)) return fail('rate_limited');
    const now = clock.now();
    const passwordHash = await hasher.hash(password);
    const result = await store.acceptInvitation({
      tokenHash: opaque.hash(token),
      now,
      user: { id: ids.uuid(), passwordHash, createdAt: now },
    });
    if (result.status === 'invalid_token') {
      log.warn('invite_invalid_token');
      return fail('invalid_token');
    }
    if (result.status === 'email_taken') return fail('email_taken');
    return ok(await issueSession(result.user, result.organization));
  };

  // Спека 024, 4.8: роль и блокировка. Отзыв токенов — при новой блокировке или смене роли на другую.
  const updateUser = async (
    accessToken: string | undefined,
    userId: string,
    body: unknown,
  ): Promise<Result<ManagedUser>> => {
    const auth = await authenticate(accessToken);
    if (!auth.ok) return auth;
    const { actor } = auth.value;
    if (!can(actor, 'user.manage')) return fail('forbidden');
    const parsed = parse(UserUpdate, body);
    if (!parsed.ok) return parsed;
    const found = await store.findUserById(userId);
    if (!found) return fail('not_found');
    const { user } = found;
    if (user.id === actor.userId || user.role === 'supervisor') return fail('forbidden');
    if (actor.role === 'admin' && user.orgId !== actor.orgId) return fail('not_found');
    const { role, blocked } = parsed.value;
    const now = clock.now();
    const blocking = blocked === true && user.blockedAt === null;
    const roleChanged = role !== undefined && role !== user.role;
    const updated = await store.updateUser({
      id: user.id,
      ...(role === undefined ? {} : { role }),
      ...(blocked === undefined ? {} : { blockedAt: blocked ? now : null }),
      ...(blocking || roleChanged ? { revokeAt: now } : {}),
    });
    log.info('user_updated', {
      userId: actor.userId,
      targetId: user.id,
      role: updated.role,
      blocked: updated.blockedAt !== null,
    });
    return ok(managedUser(updated));
  };

  // Отзывы для api (024, 4.12): только записи новее срока жизни токена доступа.
  const tokenRevocations = async (): Promise<TokenRevocationList> => {
    const since = clock.now() - settings.accessTtlS * 1000;
    return { revocations: await store.tokenRevocations(since) };
  };

  const purgeExpired = async (): Promise<void> => {
    const removed = await store.purge(clock.now() - RETENTION_MS);
    log.info('identity_purged', removed);
  };

  // Исключение хранилища или ядра превращается в internal_error. В лог пишется только имя операции:
  // текст ошибки (например, `detail` Postgres) может содержать email, поэтому `err` не передаём (4.3, D-115).
  const guarded =
    <A extends unknown[], T>(operation: string, fn: (...args: A) => Promise<Result<T>>) =>
    async (...args: A): Promise<Result<T>> => {
      try {
        return await fn(...args);
      } catch {
        log.error('identity_operation_failed', { operation });
        return fail('internal_error');
      }
    };

  return {
    info: () => ({ service: 'identity', version: deps.version }),
    requestRegistration: guarded('requestRegistration', requestRegistration),
    confirmRegistration: guarded('confirmRegistration', confirmRegistration),
    login: guarded('login', login),
    refresh: guarded('refresh', refresh),
    logout: guarded('logout', logout),
    me: guarded('me', me),
    listUsers: guarded('listUsers', listUsers),
    listOrganizations: guarded('listOrganizations', listOrganizations),
    inviteUser: guarded('inviteUser', inviteUser),
    acceptInvitation: guarded('acceptInvitation', acceptInvitation),
    updateUser: guarded('updateUser', updateUser),
    tokenRevocations,
    purgeExpired,
    ensureSupervisor,
  };
}
