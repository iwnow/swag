import { randomUUID } from 'node:crypto';
import { vi } from 'vitest';
import { AccessTokenClaims } from '@swag/contracts';
import {
  createMemoryIdentityStore,
  createMemoryMailer,
  createMemoryRateLimiter,
} from '@swag/adapter-memory';
import {
  createIdentityCore,
  type IdentityCoreDeps,
  type LogContext,
  type MailMessage,
  type OpaqueTokens,
  type TokenSigner,
  type TokenVerifier,
} from '../src/index.ts';

// Общие фейки для тестов ядра identity (спека 012, T-6…T-10). Значения явно фейковые:
// настоящей криптографии здесь нет. Хэш — `fake-hash:<пароль>`, токены — 43 цифры, JWT — `fake.<json>`.

export const NOW = 1_700_000_000_000;
export const HOUR_MS = 3_600_000;
export const CONFIRM_URL = 'http://127.0.0.1:4200/auth/confirm';
export const INVITE_URL = 'http://127.0.0.1:4200/auth/invite';

export type LogEntry = {
  level: 'debug' | 'info' | 'warn' | 'error';
  msg: string;
  ctx?: LogContext | undefined;
};

export interface TestSettings {
  confirmUrl: string;
  accessTtlS: number;
  refreshTtlS: number;
  confirmTtlS: number;
  inviteUrl: string;
  inviteTtlS: number;
  supervisor: { email: string; password: string } | null;
}

export function createTestEnv(overrides: Partial<TestSettings> = {}) {
  let time = NOW;
  const clock = {
    now: () => time,
    advance: (ms: number) => {
      time += ms;
    },
  };

  const entries: LogEntry[] = [];
  const record =
    (level: LogEntry['level']) =>
    (msg: string, ctx?: LogContext): void => {
      entries.push({ level, msg, ctx });
    };
  const log = {
    debug: record('debug'),
    info: record('info'),
    warn: record('warn'),
    error: record('error'),
  };

  // Хэш не содержит сам токен (даже в обратном порядке хватает, чтобы строка токена не встречалась в хэше).
  const fakeHash = (token: string): string => `fake-sha:${[...token].reverse().join('')}`;
  let tokenCounter = 0;
  const opaque: OpaqueTokens = {
    create: () => {
      tokenCounter += 1;
      const token = String(tokenCounter).padStart(43, '0');
      return { token, hash: fakeHash(token) };
    },
    hash: fakeHash,
  };

  const hasher = {
    hash: vi.fn(async (password: string) => `fake-hash:${password}`),
    verify: vi.fn(async (hash: string, password: string) => hash === `fake-hash:${password}`),
  };

  const signer: TokenSigner = {
    sign: async (claims) => `fake.${JSON.stringify(claims)}`,
  };
  const verifier: TokenVerifier = {
    verify: async (token) => {
      if (!token.startsWith('fake.')) return null;
      try {
        const parsed = AccessTokenClaims.safeParse(JSON.parse(token.slice('fake.'.length)));
        if (!parsed.success) return null;
        return parsed.data.exp <= Math.floor(time / 1000) ? null : parsed.data;
      } catch {
        return null;
      }
    },
  };

  const store = createMemoryIdentityStore();
  const mailer = createMemoryMailer();
  const limiter = createMemoryRateLimiter({ now: clock.now });

  const settings: TestSettings = {
    confirmUrl: CONFIRM_URL,
    accessTtlS: 900,
    refreshTtlS: 2_592_000,
    confirmTtlS: 86_400,
    inviteUrl: INVITE_URL,
    inviteTtlS: 604_800,
    supervisor: null,
    ...overrides,
  };

  const deps: IdentityCoreDeps = {
    version: 'test',
    store,
    hasher,
    opaque,
    signer,
    verifier,
    mailer,
    limiter,
    clock,
    ids: { uuid: () => randomUUID() },
    log,
    settings,
  };

  return { deps, core: createIdentityCore(deps), clock, entries, store, mailer, hasher, verifier };
}

export type TestEnv = ReturnType<typeof createTestEnv>;

// Токен подтверждения из ссылки письма: `…?token=<токен>`.
export function tokenFromMail(text: string): string {
  const match = /token=([A-Za-z0-9_-]+)/.exec(text);
  if (!match?.[1]) throw new Error('в письме нет токена');
  return match[1];
}

export function sentMail(env: TestEnv, index = 0): MailMessage {
  const mail = env.mailer.sent[index];
  if (!mail) throw new Error(`письмо ${index} не отправлено`);
  return mail;
}

export const ADMIN_EMAIL = 'admin@example.test';
export const ADMIN_PASSWORD = 'correct horse battery';

const SEED_IP = '10.0.0.7';

// Организация с администратором, как после confirmRegistration (через хранилище).
export async function seedOrganization(
  env: TestEnv,
  email: string,
  orgName: string,
): Promise<{ userId: string; orgId: string }> {
  const userId = randomUUID();
  const orgId = randomUUID();
  const tokenHash = `seed-org-${randomUUID()}`;
  await env.store.addConfirmation({ tokenHash, email, expiresAt: NOW + HOUR_MS, createdAt: NOW });
  await env.store.confirmRegistration({
    tokenHash,
    now: NOW,
    org: { id: orgId, name: orgName, createdAt: NOW },
    user: {
      id: userId,
      passwordHash: `fake-hash:${ADMIN_PASSWORD}`,
      role: 'admin',
      orgId,
      createdAt: NOW,
      blockedAt: null,
      tokensValidAfter: null,
    },
  });
  return { userId, orgId };
}

// Участник организации с ролью user, пароль — ADMIN_PASSWORD.
export async function addMember(env: TestEnv, email: string, orgId: string): Promise<string> {
  const id = randomUUID();
  await env.store.createUser({
    id,
    email,
    passwordHash: `fake-hash:${ADMIN_PASSWORD}`,
    role: 'user',
    orgId,
    createdAt: NOW,
    blockedAt: null,
    tokensValidAfter: null,
  });
  return id;
}

// Вход через ядро; возвращает сессию (токены), иначе бросает.
export async function loginAs(env: TestEnv, email: string, password = ADMIN_PASSWORD) {
  const result = await env.core.login({ email, password }, { ip: SEED_IP });
  if (!result.ok) throw new Error(`вход ${email}: ${result.error.code}`);
  return result.value;
}

// Пользователь с организацией, как после confirmRegistration (через хранилище, без HTTP).
export async function seedAdmin(env: TestEnv): Promise<{ userId: string; orgId: string }> {
  const userId = randomUUID();
  const orgId = randomUUID();
  await env.store.addConfirmation({
    tokenHash: 'seed-token-hash',
    email: ADMIN_EMAIL,
    expiresAt: NOW + HOUR_MS,
    createdAt: NOW,
  });
  await env.store.confirmRegistration({
    tokenHash: 'seed-token-hash',
    now: NOW,
    org: { id: orgId, name: 'Компания', createdAt: NOW },
    user: {
      id: userId,
      passwordHash: `fake-hash:${ADMIN_PASSWORD}`,
      role: 'admin',
      orgId,
      createdAt: NOW,
      blockedAt: null,
      tokensValidAfter: null,
    },
  });
  return { userId, orgId };
}
