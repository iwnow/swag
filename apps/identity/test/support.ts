import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createNodeOpaqueTokens, createArgon2Hasher } from '@swag/adapter-crypto';
import {
  createMemoryExporters,
  startTelemetry,
  tracedHttpServer,
  type MemoryExporters,
  type Telemetry,
} from '@swag/adapter-telemetry';
import {
  createMemoryIdentityStore,
  createMemoryMailer,
  createMemoryRateLimiter,
  type MemoryMailer,
} from '@swag/adapter-memory';
import { createIdentityCore, type IdentityCore, type IdentityStore } from '@swag/identity-core';
import { buildApp, type AppSettings } from '../src/app.ts';
import { jwtKeys } from '../src/start.ts';

// Оболочка identity с ядром на адаптерах в памяти, настоящими argon2, jose и телеметрией в памяти.
export const KID = 'test-1';
export const ACCESS_TTL_S = 900;
export const REFRESH_TTL_S = 2592000;
export const CONFIRM_TTL_S = 86400;
export const INVITE_URL = 'http://127.0.0.1:4200/auth/invite';
export const INVITE_TTL_S = 604800;
export const CONFIRM_URL = 'http://127.0.0.1:4200/auth/confirm';

const open: Harness[] = [];
// Закрывает все оболочки после каждого теста файла.
export function closeHarnessesAfterEach(): void {
  afterEach(async () => {
    await Promise.all(open.splice(0).map((h) => h.close()));
  });
}

export interface Harness {
  app: FastifyInstance;
  core: IdentityCore;
  store: IdentityStore;
  mailer: MemoryMailer;
  exporters: MemoryExporters;
  telemetry: Telemetry;
  lines: string[];
  clock: { now(): number; shift(ms: number): void };
  privateKeyBase64: string;
  close(): Promise<void>;
}

export interface HarnessOptions {
  cookieSecure?: boolean;
  bodyLimit?: number;
  supervisor?: { email: string; password: string } | null;
}

export const privateKeyBase64 = (): string => {
  const { privateKey } = generateKeyPairSync('ed25519');
  return Buffer.from(privateKey.export({ type: 'pkcs8', format: 'pem' })).toString('base64');
};

export async function makeHarness(options: HarnessOptions = {}): Promise<Harness> {
  const lines: string[] = [];
  const exporters = createMemoryExporters();
  const telemetry = startTelemetry({
    service: 'identity',
    version: 'test',
    otlpEndpoint: null,
    logLevel: 'debug',
    flushTimeoutMs: 2000,
    stdout: (line) => lines.push(line),
    exporters: { spans: exporters.spans, logs: exporters.logs },
  });
  const mailer = createMemoryMailer();
  const store = createMemoryIdentityStore();
  const start = Date.now();
  let shift = 0;
  const clock = { now: () => start + shift, shift: (ms: number) => void (shift += ms) };
  const key = privateKeyBase64();
  const { signer, verifier } = jwtKeys({ privateKeyBase64: key, kid: KID });
  const core = createIdentityCore({
    version: 'test',
    store,
    hasher: createArgon2Hasher(),
    opaque: createNodeOpaqueTokens(),
    signer,
    verifier,
    mailer,
    limiter: createMemoryRateLimiter({ now: clock.now }),
    clock,
    ids: { uuid: () => randomUUID() },
    log: telemetry.logger,
    settings: {
      confirmUrl: CONFIRM_URL,
      accessTtlS: ACCESS_TTL_S,
      refreshTtlS: REFRESH_TTL_S,
      confirmTtlS: CONFIRM_TTL_S,
      inviteUrl: INVITE_URL,
      inviteTtlS: INVITE_TTL_S,
      supervisor: options.supervisor ?? null,
    },
  });
  await core.ensureSupervisor();
  const settings: AppSettings = {
    cookieSecure: options.cookieSecure ?? false,
    refreshTtlS: REFRESH_TTL_S,
    bodyLimit: options.bodyLimit ?? 16384,
  };
  const app = await buildApp(core, settings, {
    loggerInstance: telemetry.logger.pino,
    serverFactory: tracedHttpServer(telemetry, { ignorePaths: ['/health'] }),
  });
  const harness: Harness = {
    app,
    core,
    store,
    mailer,
    exporters,
    telemetry,
    lines,
    clock,
    privateKeyBase64: key,
    close: async () => {
      await app.close();
      await telemetry.shutdown();
    },
  };
  open.push(harness);
  return harness;
}

export const PASSWORD = 'correct-horse-battery';
export const EMAIL = 'owner@example.com';

// Токен подтверждения из последнего письма «Подтвердите регистрацию» — только в тестах.
export function confirmTokenFrom(mailer: MemoryMailer): string {
  const message = [...mailer.sent].reverse().find((m) => m.text.includes('token='));
  const match = message?.text.match(/token=([A-Za-z0-9_-]{43})/);
  if (!match?.[1]) throw new Error('no confirmation token in mail');
  return match[1];
}

// Cookie swag_refresh из заголовка Set-Cookie: значение и все атрибуты строкой.
export function setCookieOf(response: { headers: Record<string, unknown> }): string | undefined {
  const raw = response.headers['set-cookie'];
  const values = Array.isArray(raw) ? raw : [raw];
  return values.find(
    (value): value is string => typeof value === 'string' && value.startsWith('swag_refresh='),
  );
}

export function refreshValueOf(response: { headers: Record<string, unknown> }): string | undefined {
  return setCookieOf(response)?.split(';')[0]?.slice('swag_refresh='.length);
}

export async function registerAndConfirm(
  h: Harness,
  email = EMAIL,
  organizationName = 'Компания',
  password = PASSWORD,
) {
  await h.app.inject({ method: 'POST', url: '/auth/registrations', payload: { email } });
  const token = confirmTokenFrom(h.mailer);
  return h.app.inject({
    method: 'POST',
    url: '/auth/registrations/confirm',
    payload: { token, password, organizationName },
  });
}

// Записи логов в JSON: строка на запись (REQ-016-2).
export function logRecords(h: Harness): Record<string, unknown>[] {
  return h.lines.map((line) => JSON.parse(line) as Record<string, unknown>);
}

// Декодирует JWT без проверки подписи: только для утверждений в тестах.
export function decodeJwt(token: string): {
  header: Record<string, unknown>;
  payload: Record<string, unknown>;
} {
  const [header, payload] = token.split('.');
  const decode = (part: string | undefined) =>
    JSON.parse(Buffer.from(part ?? '', 'base64url').toString('utf8')) as Record<string, unknown>;
  return { header: decode(header), payload: decode(payload) };
}
