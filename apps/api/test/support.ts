import { generateKeyPairSync } from 'node:crypto';
import {
  createApiCore,
  type ApiCore,
  type Logger,
  type OrchestratorClient,
  type SwarmStore,
} from '@swag/api-core';
import { createMemorySwarmStore } from '@swag/adapter-memory';
import { createJoseSigner, createJoseVerifier } from '@swag/adapter-jose';
import { actorFromClaims, type Actor, type Role, type TokenRevocationList } from '@swag/contracts';
import { createAuthenticator } from '../src/auth.ts';
import { createRevocationSync, type RevocationSync } from '../src/revocations.ts';
import { createBlockHandler, createStreamRegistry } from '../src/streams.ts';

const nothing = () => undefined;
export const silentLog: Logger = { debug: nothing, info: nothing, warn: nothing, error: nothing };

// Ядро api с памятью и фейковым оркестратором для тестов оболочки.
export function makeCore(
  orchestrator: OrchestratorClient = { launch: async () => undefined, stop: async () => undefined },
  log: Logger = silentLog,
  store: SwarmStore = createMemorySwarmStore(),
): ApiCore {
  let counter = 0;
  return createApiCore({
    version: 'test',
    store,
    orchestrator,
    clock: { now: () => '2026-10-22T10:00:00.000Z' },
    ids: { uuid: () => `00000000-0000-4000-8000-${String(++counter).padStart(12, '0')}` },
    log,
    trace: { currentTraceId: () => null },
    limits: { maxActiveSwarms: 3, maxBudgetMicroUsd: 5000000, maxTokens: 65536 },
  });
}

export const body = (count: number) => ({
  task: 'Задача',
  budgetMicroUsd: 1000000,
  agents: Array.from({ length: count }, (_, i) => ({
    name: `Агент ${i + 1}`,
    role: `роль ${i + 1}`,
  })),
});

// Тестовая пара Ed25519 генерируется на каждый прогон; ключ нигде не хранится.
const keys = generateKeyPairSync('ed25519', {
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});
export const TEST_KID = 'test-kid';

export const ORG_A = '00000000-0000-4000-8000-0000000000a0';
export const ORG_B = '00000000-0000-4000-8000-0000000000b0';

export interface Who {
  sub: string;
  org: string | null;
  role: Role;
}

// Пользователи фикстур: U1 и U2 — организация A, B — организация B, admin — администратор A, sup — супервизор.
export const WHO = {
  u1: { sub: '00000000-0000-4000-8000-000000000101', org: ORG_A, role: 'user' },
  u2: { sub: '00000000-0000-4000-8000-000000000102', org: ORG_A, role: 'user' },
  b: { sub: '00000000-0000-4000-8000-000000000201', org: ORG_B, role: 'user' },
  adminA: { sub: '00000000-0000-4000-8000-000000000301', org: ORG_A, role: 'admin' },
  sup: { sub: '00000000-0000-4000-8000-000000000401', org: null, role: 'supervisor' },
} satisfies Record<string, Who>;

export function actorOf(who: Who): Actor {
  return actorFromClaims({ ...who, iss: 'swag-identity', aud: 'swag', iat: 0, exp: 0 });
}

export async function tokenOf(
  who: Who,
  options: { iat?: number; exp?: number; kid?: string } = {},
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const signer = createJoseSigner({
    privateKeyPem: keys.privateKey,
    kid: options.kid ?? TEST_KID,
  });
  return signer.sign({
    sub: who.sub,
    org: who.org,
    role: who.role,
    iss: 'swag-identity',
    aud: 'swag',
    iat: options.iat ?? now,
    exp: options.exp ?? now + 900,
  });
}

export const T = {
  u1: await tokenOf(WHO.u1),
  u2: await tokenOf(WHO.u2),
  b: await tokenOf(WHO.b),
  adminA: await tokenOf(WHO.adminA),
  sup: await tokenOf(WHO.sup),
};

export const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

// Оболочка с уже выполненной первой синхронизацией (как после старта в main.ts).
export async function makeStartedAuth(
  options: { core?: ApiCore; maxStaleMs?: number | undefined } = {},
): Promise<AuthEnv> {
  const env = makeAuth(options);
  await env.revocations.start();
  return env;
}

export interface AuthEnv {
  app: {
    authenticate: ReturnType<typeof createAuthenticator>;
    streams: ReturnType<typeof createStreamRegistry>;
  };
  revocations: RevocationSync;
  streams: ReturnType<typeof createStreamRegistry>;
  state: { list: TokenRevocationList; failing: boolean; fetches: number };
  clock: { now: number };
  tick: () => void;
}

// Оболочка с настоящим верификатором и синхронизацией отзывов в памяти: список, сбой и часы подменяются тестом.
// tick() запускает интервальную синхронизацию, которую иначе запускал бы таймер.
export function makeAuth(
  options: { core?: ApiCore; maxStaleMs?: number | undefined } = {},
): AuthEnv {
  const state: AuthEnv['state'] = { list: { revocations: [] }, failing: false, fetches: 0 };
  const clock = { now: 1_000_000_000_000 };
  const streams = createStreamRegistry();
  let intervalHandler: (() => void) | null = null;
  const revocations = createRevocationSync({
    fetchRevocations: async () => {
      state.fetches += 1;
      if (state.failing) throw new Error('identity unreachable');
      return state.list;
    },
    onBlocked: options.core ? createBlockHandler(options.core, streams) : async () => undefined,
    pollMs: 1000,
    maxStaleMs: options.maxStaleMs ?? 30000,
    now: () => clock.now,
    timers: {
      setInterval: (handler) => {
        intervalHandler = handler;
        return 1;
      },
      clearInterval: () => {
        intervalHandler = null;
      },
    },
    log: silentLog,
  });
  const verifier = createJoseVerifier({ publicKeyPem: keys.publicKey, kid: TEST_KID });
  const authenticate = createAuthenticator({ verifier, revocations });
  return {
    app: { authenticate, streams },
    revocations,
    streams,
    state,
    clock,
    tick: () => intervalHandler?.(),
  };
}

// Лог, в который пишут логгер фастифая и ядро: строки JSON для проверки «без токенов в логе».
export function captureLog(): {
  entries: Array<Record<string, unknown>>;
  text: () => string;
  stream: { write(line: string): void };
  logger: Logger;
} {
  const entries: Array<Record<string, unknown>> = [];
  const push = (level: string, msg: string, ctx?: Record<string, unknown>) =>
    entries.push({ level, msg, ...ctx });
  return {
    entries,
    text: () => JSON.stringify(entries),
    stream: {
      write(line: string) {
        entries.push(JSON.parse(line) as Record<string, unknown>);
      },
    },
    logger: {
      debug: (msg, ctx) => push('debug', msg, ctx),
      info: (msg, ctx) => push('info', msg, ctx),
      warn: (msg, ctx) => push('warn', msg, ctx),
      error: (msg, ctx) => push('error', msg, ctx),
    },
  };
}

export const otherKeyToken = () => tokenOf(WHO.u1, { kid: 'foreign-kid' });
