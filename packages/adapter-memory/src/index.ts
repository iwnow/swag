import type { SwarmStore } from '@swag/api-core';
import { applyEvent, type SwarmView } from '@swag/api-integration';
import type { PlatformEvent } from '@swag/contracts';
import type {
  IdentityStore,
  MailMessage,
  Mailer,
  RateLimiter,
  StoredOrganization,
  StoredUser,
} from '@swag/identity-core';

// Спека 001, 4.10; спека 003, REQ-003-10: SwarmStore в памяти с тем же асинхронным портом.
// Остаётся для тестов ядра; при перезапуске всё теряется. Рабочее хранилище — @swag/adapter-postgres (спека 003, T-5, T-6).
export function createMemorySwarmStore(): SwarmStore {
  const events = new Map<string, PlatformEvent[]>();
  const views = new Map<string, SwarmView>();

  return {
    async appendEvent(event: PlatformEvent): Promise<void> {
      const current = views.get(event.swarmId) ?? null;
      const next = applyEvent(current, event); // бросает на недопустимое событие — тогда ничего не сохраняется
      if (next === current) return; // повтор seq — уже учтено
      views.set(event.swarmId, next);
      const list = events.get(event.swarmId) ?? [];
      list.push(event);
      events.set(event.swarmId, list);
    },

    async events(swarmId: string, afterSeq: number): Promise<PlatformEvent[]> {
      return (events.get(swarmId) ?? []).filter((event) => event.seq > afterSeq);
    },

    async view(swarmId: string): Promise<SwarmView | null> {
      return views.get(swarmId) ?? null;
    },

    async views(): Promise<SwarmView[]> {
      return [...views.values()];
    },
  };
}

// Спека 012, 4.3 и 4.7: хранилище identity в памяти. Каждая операция синхронна внутри
// async-функции, поэтому атомарна на одном потоке JS (правила транзакций из 4.3).
type MemoryConfirmation = {
  tokenHash: string;
  email: string;
  expiresAt: number;
  createdAt: number;
  usedAt: number | null;
};

type MemoryInvitation = {
  tokenHash: string;
  email: string;
  orgId: string;
  role: 'user' | 'admin';
  invitedBy: string;
  expiresAt: number;
  createdAt: number;
  usedAt: number | null;
};

type MemorySession = {
  id: string;
  userId: string;
  refreshHash: string;
  previousHash: string | null;
  expiresAt: number;
  createdAt: number;
  revokedAt: number | null;
};

export type MemoryIdentityStore = IdentityStore;

const byEmail = (a: StoredUser, b: StoredUser): number =>
  a.email < b.email ? -1 : a.email > b.email ? 1 : 0;

export function createMemoryIdentityStore(): MemoryIdentityStore {
  const users = new Map<string, StoredUser>();
  const organizations = new Map<string, StoredOrganization>();
  const confirmations = new Map<string, MemoryConfirmation>();
  const sessions = new Map<string, MemorySession>();
  const invitations = new Map<string, MemoryInvitation>();

  const userByEmail = (email: string): StoredUser | undefined =>
    [...users.values()].find((user) => user.email === email);
  const liveSession = (
    now: number,
    match: (session: MemorySession) => boolean,
  ): MemorySession | undefined =>
    [...sessions.values()].find((s) => s.revokedAt === null && s.expiresAt > now && match(s));

  return {
    async findUserByEmail(email: string): Promise<StoredUser | null> {
      const user = userByEmail(email);
      return user ? { ...user } : null;
    },

    async findUserById(id: string) {
      const user = users.get(id);
      if (!user) return null;
      const organization = user.orgId ? (organizations.get(user.orgId) ?? null) : null;
      return { user: { ...user }, organization: organization ? { ...organization } : null };
    },

    async hasSupervisor(): Promise<boolean> {
      return [...users.values()].some((user) => user.role === 'supervisor');
    },

    async createUser(user: StoredUser): Promise<void> {
      if (userByEmail(user.email)) throw new Error('email already exists');
      users.set(user.id, { ...user });
    },

    async addConfirmation(c): Promise<void> {
      if (confirmations.has(c.tokenHash)) throw new Error('token hash already exists');
      confirmations.set(c.tokenHash, { ...c, usedAt: null });
    },

    async confirmRegistration({ tokenHash, now, org, user }) {
      const confirmation = confirmations.get(tokenHash);
      if (!confirmation || confirmation.usedAt !== null || confirmation.expiresAt <= now) {
        return { status: 'invalid_token' };
      }
      if (userByEmail(confirmation.email)) return { status: 'email_taken' }; // токен не гасится
      confirmation.usedAt = now;
      organizations.set(org.id, { ...org });
      users.set(user.id, { ...user, email: confirmation.email });
      return { status: 'ok', email: confirmation.email };
    },

    async createSession(s): Promise<void> {
      sessions.set(s.id, { ...s, previousHash: null, revokedAt: null });
    },

    async rotateSession({ oldHash, newHash, now, expiresAt }) {
      const current = liveSession(now, (s) => s.refreshHash === oldHash);
      if (current) {
        current.previousHash = current.refreshHash;
        current.refreshHash = newHash;
        current.expiresAt = expiresAt;
        return { status: 'ok', userId: current.userId };
      }
      const reused = liveSession(now, (s) => s.previousHash === oldHash);
      if (reused) {
        reused.revokedAt = now;
        return { status: 'reused', userId: reused.userId };
      }
      return { status: 'invalid' };
    },

    async revokeSession(refreshHash: string, now: number): Promise<void> {
      const session = liveSession(now, (s) => s.refreshHash === refreshHash);
      if (session) session.revokedAt = now;
    },

    async listUsers({ orgId }) {
      return [...users.values()]
        .filter((user) => orgId === undefined || user.orgId === orgId)
        .sort(byEmail)
        .map((user) => ({ ...user }));
    },

    async updateUser({ id, role, blockedAt, revokeAt }) {
      const user = users.get(id);
      if (!user) throw new Error('user not found');
      if (role !== undefined) user.role = role;
      if (blockedAt !== undefined) user.blockedAt = blockedAt;
      if (revokeAt !== undefined) {
        user.tokensValidAfter = revokeAt;
        for (const session of sessions.values()) {
          if (session.userId === id && session.revokedAt === null) session.revokedAt = revokeAt;
        }
      }
      return { ...user };
    },

    async addInvitation(i) {
      if (invitations.has(i.tokenHash)) throw new Error('token hash already exists');
      invitations.set(i.tokenHash, { ...i, usedAt: null });
    },

    async acceptInvitation({ tokenHash, now, user }) {
      const invitation = invitations.get(tokenHash);
      if (!invitation || invitation.usedAt !== null || invitation.expiresAt <= now) {
        return { status: 'invalid_token' };
      }
      if (userByEmail(invitation.email)) return { status: 'email_taken' }; // приглашение не гасится
      const organization = organizations.get(invitation.orgId);
      if (!organization) throw new Error('organization not found');
      invitation.usedAt = now;
      const created: StoredUser = {
        id: user.id,
        email: invitation.email,
        passwordHash: user.passwordHash,
        role: invitation.role,
        orgId: invitation.orgId,
        createdAt: user.createdAt,
        blockedAt: null,
        tokensValidAfter: null,
      };
      users.set(created.id, created);
      return { status: 'ok', user: { ...created }, organization: { ...organization } };
    },

    async listOrganizations() {
      return [...organizations.values()]
        .map((organization) => ({
          ...organization,
          userCount: [...users.values()].filter((user) => user.orgId === organization.id).length,
        }))
        .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    },

    async tokenRevocations(since: number) {
      return [...users.values()]
        .filter((user) => user.tokensValidAfter !== null && user.tokensValidAfter > since)
        .map((user) => ({
          userId: user.id,
          validAfter: user.tokensValidAfter ?? 0,
          blocked: user.blockedAt !== null,
        }));
    },

    async purge(before: number) {
      const removeOld = <T>(map: Map<string, T>, isOld: (value: T) => boolean): number => {
        let removed = 0;
        for (const [key, value] of map) {
          if (isOld(value)) {
            map.delete(key);
            removed++;
          }
        }
        return removed;
      };
      return {
        confirmations: removeOld(confirmations, (c) => c.expiresAt < before),
        invitations: removeOld(invitations, (i) => i.expiresAt < before),
        sessions: removeOld(
          sessions,
          (s) => s.expiresAt < before || (s.revokedAt !== null && s.revokedAt < before),
        ),
      };
    },
  };
}

// Спека 012, 4.7: мейлер в памяти. Письма копятся в sent; fail = true — send отвергает, письмо не сохраняется.
export interface MemoryMailer extends Mailer {
  readonly sent: MailMessage[];
  fail: boolean;
}

export function createMemoryMailer(): MemoryMailer {
  const sent: MailMessage[] = [];
  const mailer: MemoryMailer = {
    sent,
    fail: false,
    async send(message: MailMessage): Promise<void> {
      if (mailer.fail) throw new Error('mail unavailable');
      sent.push(message);
    },
  };
  return mailer;
}

// Спека 012, 4.7, 4.8 и REQ-012-17: фиксированное окно по ключу. Когда записей больше 10000,
// при hit удаляются все истёкшие — размер Map не растёт без предела.
export interface MemoryRateLimiter extends RateLimiter {
  readonly size: number;
}

const SWEEP_THRESHOLD = 10_000;

export function createMemoryRateLimiter(deps: { now: () => number }): MemoryRateLimiter {
  const windows = new Map<string, { count: number; resetAt: number }>();

  return {
    get size() {
      return windows.size;
    },

    async hit(key: string, limit: number, windowMs: number): Promise<boolean> {
      const now = deps.now();
      if (windows.size > SWEEP_THRESHOLD) {
        for (const [name, window] of windows) {
          if (window.resetAt <= now) windows.delete(name);
        }
      }
      const window = windows.get(key);
      if (!window || window.resetAt <= now) {
        windows.set(key, { count: 1, resetAt: now + windowMs });
        return true;
      }
      if (window.count >= limit) return false;
      window.count++;
      return true;
    },
  };
}
