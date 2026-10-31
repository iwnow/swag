---
id: "024"
title: Организации и доступ
status: in-progress
roadmap_stage: 5
depends_on: ["003", "004", "012", "016"]
superseded_by: null
updated: 2026-10-31
---

# 024. Организации и доступ

> **Коротко.**
> - `api` принимает только запросы с токеном доступа identity. Токен проверяется на месте, без запроса в identity. Из него собирается вызывающий `Actor`, и ядро `api-core` решает, что ему видно. Пользователь видит свои рои, администратор — все рои организации, супервизор — все рои платформы. Чужой рой — `404`.
> - Рой запоминает организацию и автора. Фактическую стоимость вызова у провайдера видит только супервизор.
> - В identity появляется управление пользователями. Администратор приглашает пользователя письмом, меняет ему роль и блокирует. Супервизор видит организации и пользователей и тоже может блокировать.
> - Заблокированный не входит. Его действующие токены перестают приниматься в `api` за несколько секунд: `api` раз в 5 с забирает у identity список отозванных токенов. Его активные рои останавливаются.
> - `api` вызывает оркестратор по внутреннему токену. Песочница с доступом к сети compose больше не может остановить или запустить рой в обход проверки доступа.
> - В кабинете появляется страница входа: без неё кабинет перестал бы работать. Экраны регистрации, приглашения и админки — спека 014.
> - **Решения человека.** Вопросы Q-1…Q-11 закрыты по рекомендации (2026-10-31).

## 1. Контекст и цель

Роадмап, [раздел 8 «Пользователи, доступ и баланс»](../../AI_PLATFORM_ROADMAP.md#8-пользователи-доступ-и-баланс), принцип 8 «Доступ проверяется в ядре», критерии готовности 9 и 11, этап 5.

Сейчас identity (012) выпускает токены, но никто, кроме `/auth/me`, их не проверяет. `api` и оркестратор работают без аутентификации: любой, кто достучался до `/api`, видит и останавливает все рои. У роя нет владельца. Добавить пользователя в организацию и заблокировать его нельзя.

После спеки каждая операция `api-core` получает `Actor` и фильтрует рои по организации и автору. Администратор организации управляет её пользователями через identity. Блокировка действует сразу во всех сервисах, где есть данные пользователя. Сценарий S-1, шаги 7–10, проходит на уровне HTTP автотестом.

## 2. Объём

**Входит:**
- `Actor`, права `Permission`, соответствие роли и прав — в `@swag/contracts`;
- проверка токена доступа и сборка `Actor` в оболочке `api`, включая WebSocket;
- владелец роя (организация и автор) и видимость роёв по роли в `api-core`;
- скрытие `providerCostMicroUsd` от всех, кроме супервизора (из D-38);
- в identity: приглашение пользователя письмом, принятие приглашения, список пользователей, смена роли, блокировка и разблокировка, список организаций для супервизора;
- отзыв токенов при блокировке и смене роли: список отзывов в identity, синхронизация в `api`;
- остановка активных роёв заблокированного пользователя;
- внутренний токен между `api` и оркестратором;
- уборка просроченных подтверждений, приглашений и сессий (из N-20), тест гонки `rotateSession` (из N-22);
- страница входа и сессия в кабинете, прокси `/auth`;
- стек-тест S-1, шаги 7–10, и «чужой рой».

**Не входит** (агент это не делает, даже если кажется логичным):
- экраны регистрации, подтверждения, принятия приглашения, админки организации и супервизора, каркас и микрофронтенды — 014;
- баланс, пополнение, право `balance.topup` — 013;
- восстановление и смена пароля — D-112;
- доверие к прокси и ключ лимитов по `X-Forwarded-For` — D-118, перед выходом в прод;
- блокировка и удаление организации целиком, смена email, удаление пользователя, перенос пользователя в другую организацию;
- создание супервизоров через API: супервизор по-прежнему только из `.env` (012, Q-3);
- проверка `Actor` в LLM Gateway и в агенте: им токен пользователя не передаётся (роадмап, раздел 8); общий `LLM_GATEWAY_TOKEN` агента остаётся, как в 004;
- аутентификация NATS и изоляция шины — 007;
- лимит активных роёв на организацию: `MAX_ACTIVE_SWARMS` остаётся общим;
- фильтр роёв по владельцу на стороне SQL: в 024 ядро фильтрует `views()` в памяти;
- аудит действий администраторов — после MVP (роадмап, этап 14);
- ротация ключа подписи и JWKS — после MVP (012).

## 3. Требования

| ID | Требование | Приоритет |
|---|---|---|
| REQ-024-1 | `@swag/contracts` MUST экспортировать `Permission`, `ROLE_PERMISSIONS`, `Actor`, `actorFromClaims`, `can` по 4.1. | MUST |
| REQ-024-2 | Оболочка `api` MUST требовать токен доступа на всех маршрутах, кроме `GET /health`: `Authorization: Bearer` для REST и подпротокол 4.6 для WebSocket. Проверка — подпись, `kid`, `iss`, `aud`, срок, без запроса в identity. Нет токена, токен не прошёл или отозван — `401 unauthorized`, у WebSocket — закрытие `4401`. | MUST |
| REQ-024-3 | Каждая операция `api-core` с данными роя MUST принимать `Actor` первым аргументом и отдавать только видимые ему рои по правилу 4.4. Невидимый рой — `not_found`, нет права — `forbidden`. | MUST |
| REQ-024-4 | `createSwarm` MUST записывать в `swarm.created` организацию и автора из `Actor`. | MUST |
| REQ-024-5 | `api-core` MUST отдавать `providerCostMicroUsd` событий `llm.call` только супервизору, остальным — `null` (REST и WebSocket). | MUST |
| REQ-024-6 | Администратор организации MUST приглашать пользователя письмом со ссылкой. Принятие приглашения создаёт пользователя в организации администратора с ролью из приглашения и пускает его в сессию. | MUST |
| REQ-024-7 | Администратор MUST видеть пользователей своей организации, менять им роль `user` ↔ `admin`, блокировать и разблокировать их, кроме себя. Супервизор MUST видеть все организации и всех пользователей и делать то же с любым пользователем, кроме супервизоров. | MUST |
| REQ-024-8 | Заблокированный пользователь MUST не входить (`403 user_blocked` после верного пароля). Блокировка и смена роли MUST отзывать все его сессии и делать недействительными ранее выпущенные токены доступа. | MUST |
| REQ-024-9 | identity MUST отдавать список отзывов по внутреннему токену, `api` MUST забирать его раз в `API_REVOCATION_POLL_MS` и отклонять отозванные токены. Без успешной синхронизации дольше `API_REVOCATION_MAX_STALE_MS` `api` MUST отвечать `503 auth_unavailable`, а не пускать. | MUST |
| REQ-024-10 | `api` MUST останавливать активные рои пользователя, когда узнаёт о его блокировке. | MUST |
| REQ-024-11 | Оркестратор MUST принимать `POST /swarms` и `POST /swarms/:id/stop` только с `Authorization: Bearer <ORCHESTRATOR_TOKEN>`. | MUST |
| REQ-024-12 | identity MUST удалять просроченные и погашенные подтверждения, приглашения и закрытые сессии старше срока хранения 4.9 (из N-20). | MUST |
| REQ-024-13 | Кабинет MUST пускать к роям только после входа, хранить токен доступа в памяти страницы, обновлять его по cookie при `401` один раз и уводить на вход при неудаче. | MUST |
| REQ-024-14 | Логи `api` и identity MUST не содержать токенов, паролей и email (кроме того, что разрешено 012). | MUST |

## 4. Контракты

### 4.1. `@swag/contracts`, файл `src/access.ts`

Экспортируется из `src/index.ts`.

```ts
import { z } from 'zod';
import { type AccessTokenClaims, type Role } from './auth.ts';

export const Permission = z.enum([
  'swarm.create', 'swarm.read', 'swarm.stop', 'user.manage', 'organization.read',
]);
export type Permission = z.infer<typeof Permission>;

export const ROLE_PERMISSIONS: Record<Role, readonly Permission[]> = {
  user: ['swarm.create', 'swarm.read', 'swarm.stop'],
  admin: ['swarm.create', 'swarm.read', 'swarm.stop', 'user.manage'],
  supervisor: ['swarm.read', 'swarm.stop', 'user.manage', 'organization.read'], // Q-4: роёв не создаёт
};

export type Actor = {
  userId: string;
  orgId: string | null; // null только у supervisor
  role: Role;
  permissions: readonly Permission[];
};

export function actorFromClaims(claims: AccessTokenClaims): Actor; // permissions = ROLE_PERMISSIONS[role]
export function can(actor: Actor, permission: Permission): boolean;
```

Права определяют, что можно делать. Чьи данные видны — область по роли (4.4, 4.7): `user` — свои, `admin` — своей организации, `supervisor` — все.

### 4.2. `@swag/contracts`, дополнения `src/auth.ts`

```ts
export const AuthErrorCode = z.enum([
  // как в 012, плюс:
  'forbidden', 'not_found', 'user_blocked',
]);

export const OrgRole = z.enum(['user', 'admin']); // роль, которую можно выдать через API

export const ManagedUser = z.object({
  id: UserId, email: z.string(), role: Role, orgId: OrgId.nullable(),
  blocked: z.boolean(), createdAt: z.iso.datetime(),
});
export const UserList = z.object({ users: z.array(ManagedUser) }); // по email, по возрастанию

export const InvitationRequest = z.object({ email: Email, role: OrgRole });
export const InvitationAcceptRequest = z.object({ token: z.string().min(1).max(200), password: Password });

export const UserUpdate = z
  .object({ role: OrgRole.optional(), blocked: z.boolean().optional() })
  .refine((u) => u.role !== undefined || u.blocked !== undefined);

export const OrganizationSummary = z.object({ id: OrgId, name: z.string(), createdAt: z.iso.datetime(), userCount: z.number().int() });
export const OrganizationList = z.object({ organizations: z.array(OrganizationSummary) }); // по name

export const TokenRevocation = z.object({
  userId: UserId,
  validAfter: z.number().int(), // мс эпохи: токен с iat * 1000 < validAfter недействителен
  blocked: z.boolean(),
});
export const TokenRevocationList = z.object({ revocations: z.array(TokenRevocation) });
```

У каждой схемы — `export type` той же формы, как в 012.

### 4.3. События и проекция роя

`swarm.created`, `data` дополняется двумя полями. Они необязательны, чтобы читались события до 024:

```ts
orgId: OrgId.nullable().optional(),     // организация автора; null — рой до 024
createdBy: UserId.nullable().optional(), // автор
```

`SwarmView` (`@swag/api-integration`) дополняется полями `orgId: string | null` и `createdBy: string | null`. Проекция берёт их из `swarm.created`, отсутствующее поле — `null`.

### 4.4. `api-core`: операции и видимость

```ts
export interface ApiCore {
  info(): ServiceInfo;
  createSwarm(actor: Actor, body: unknown): Promise<Result<SwarmView>>;
  listSwarms(actor: Actor): Promise<SwarmSummary[]>;
  getSwarm(actor: Actor, id: string): Promise<Result<SwarmView>>;
  getEvents(actor: Actor, id: string, after: number): Promise<Result<PlatformEvent[]>>;
  stopSwarm(actor: Actor, id: string): Promise<Result<void>>;
  subscribe(actor: Actor, swarmId: string, after: number, listener: (e: PlatformEvent) => void): Promise<Result<() => void>>;
  stopSwarmsOfUser(userId: string): Promise<number>; // активные рои с createdBy = userId; число остановленных
  ingestEvent(raw: unknown): Promise<void>;   // без изменений
  ingestMessage(raw: unknown): Promise<void>; // без изменений
  closeInterrupted(): Promise<number>;        // без изменений
}
```

Правила:
1. **Видимость роя** `visible(actor, view)`: `supervisor` — всегда; `admin` — `view.orgId === actor.orgId`; `user` — `view.createdBy === actor.userId` (Q-1). Рой до 024 (`orgId = null`) виден только супервизору.
2. Невидимый или несуществующий рой — `not_found` с тем же текстом, что сейчас (Q-5). `listSwarms` возвращает только видимые.
3. Право проверяется до разбора тела: `createSwarm` без `swarm.create` — `forbidden`, `getSwarm`/`getEvents`/`listSwarms`/`subscribe` без `swarm.read` — `forbidden`, `stopSwarm` без `swarm.stop` — `forbidden`.
4. `createSwarm` пишет в `swarm.created` `orgId = actor.orgId` и `createdBy = actor.userId`. Остальные проверки и их порядок — как сейчас.
5. `getEvents` и `subscribe` для `actor.role !== 'supervisor'` отдают `llm.call` с `data.providerCostMicroUsd = null`. В хранилище событие не меняется.
6. `stopSwarmsOfUser` вызывает тот же путь, что `stopSwarm`, для каждого роя автора в статусе `starting` или `running`, без проверки `Actor`, и пишет лог `info` `user_swarms_stopped` (`userId`, `count`). Повторный вызов ничего не меняет.

### 4.5. HTTP `api`

Маршруты и ответы — как сейчас, плюс:

| Случай | Ответ |
|---|---|
| нет `Authorization: Bearer`, токен не прошёл проверку или отозван | `401 { error: { code: 'unauthorized' } }` |
| нет права | `403 forbidden` |
| синхронизация отзывов не удалась ни разу или последняя удачная старше `API_REVOCATION_MAX_STALE_MS` | `503 auth_unavailable` |

Таблица `STATUS` оболочки дополняется: `unauthorized: 401`, `forbidden: 403`, `auth_unavailable: 503`. Проверка токена — хук `onRequest` для всех маршрутов, кроме `GET /health`. Проверку подписи делает `createJoseVerifier` из `@swag/adapter-jose` с ключом из `IDENTITY_JWT_PUBLIC_KEY` (base64 от SPKI PEM, D-117) и `IDENTITY_JWT_KID`. Отказ — лог `warn` `auth_failed` (`reason`: `missing` | `invalid` | `revoked`), без токена.

### 4.6. WebSocket `api`

Браузер не может задать заголовок `Authorization` у WebSocket, поэтому токен идёт в подпротоколе (Q-6):

```ts
new WebSocket(url, ['swag.v1', `swag.bearer.${accessToken}`]);
```

Сервер выбирает подпротокол `swag.v1` (`handleProtocols` у `@fastify/websocket`), токен берёт из `swag.bearer.*`. Нет токена или отказ — соединение принимается и сразу закрывается с кодом `4401` и причиной `unauthorized`. Нет права или рой невидим — `4404`, как сейчас для `not_found`. Токен проверяется один раз при подключении. Блокировка автора закрывает его открытые потоки кодом `4401` при ближайшей синхронизации отзывов.

### 4.7. HTTP identity: новые маршруты

Все маршруты `/auth/*` ниже требуют `Authorization: Bearer <jwt>` и проверяют его в identity так же, как `/auth/me`, плюс правило отзыва 4.8.

| Метод и путь | Право и область | Тело | Успех | Ошибки |
|---|---|---|---|---|
| `GET /auth/users?orgId=` | `user.manage`; `admin` — своя организация, `orgId` игнорируется; `supervisor` — все или `orgId` | — | `200 UserList` | `401`, `403 forbidden` |
| `POST /auth/invitations` | `user.manage` и `role = admin` | `InvitationRequest` | `202`, тело пустое | `400`, `401`, `403`, `413`, `429`, `503 mail_unavailable` |
| `POST /auth/invitations/accept` | без токена | `InvitationAcceptRequest` | `201 AuthSession` + cookie 012, 4.5 | `400 validation_error`, `400 invalid_token`, `409 email_taken`, `429` |
| `PATCH /auth/users/:id` | `user.manage`; `admin` — пользователь своей организации, не он сам; `supervisor` — любой, кроме супервизора | `UserUpdate` | `200 ManagedUser` | `400`, `401`, `403 forbidden`, `404 not_found` |
| `GET /auth/organizations` | `organization.read` | — | `200 OrganizationList` | `401`, `403` |
| `GET /internal/token-revocations` | `Authorization: Bearer <IDENTITY_INTERNAL_TOKEN>` | — | `200 TokenRevocationList` | `401 unauthorized` |
| `POST /auth/login` | как в 012 | | | плюс `403 user_blocked` |

Правила:
- `PATCH` для пользователя другой организации или несуществующего — `404 not_found`. Для себя и для супервизора — `403 forbidden`.
- Внутренний токен сравнивается через `timingSafeEqual`, как `LLM_GATEWAY_TOKEN` в gateway. Маршрут `/internal/*` не проксируется UI.
- Ответы с `accessToken` — `Cache-Control: no-store`, как в 012.

### 4.8. Ядро `identity-core`: новые операции

```ts
export interface IdentityCore {
  // как в 012, плюс:
  listUsers(accessToken: string | undefined, query: { orgId?: string }): Promise<Result<UserList>>;
  inviteUser(accessToken: string | undefined, body: unknown): Promise<Result<void>>;
  acceptInvitation(body: unknown, meta: RequestMeta): Promise<Result<IssuedSession>>;
  updateUser(accessToken: string | undefined, userId: string, body: unknown): Promise<Result<ManagedUser>>;
  listOrganizations(accessToken: string | undefined): Promise<Result<OrganizationList>>;
  tokenRevocations(): Promise<TokenRevocationList>; // проверку внутреннего токена делает оболочка
  purgeExpired(): Promise<void>;
}
```

Алгоритмы. `now` — `clock.now()`.

- **authenticate** (внутренняя, её используют `me` и все операции с токеном):
  1. `verifier.verify(token)`. Отказ — `unauthorized`.
  2. `store.findUserById(sub)`. Нет пользователя, `blockedAt !== null` или `tokensValidAfter !== null && iat * 1000 < tokensValidAfter` — `unauthorized`.
  3. Вернуть `Actor` из `actorFromClaims` по данным хранилища (роль и организация — из хранилища, не из токена).
- **login**: как в 012. После верного пароля и `blockedAt !== null` — лог `warn` `login_blocked` (`userId`) и `user_blocked`. Неверный пароль — `invalid_credentials`, как раньше, независимо от блокировки.
- **refresh**: как в 012. Пользователь сессии заблокирован — `invalid_refresh_token`.
- **listUsers**: `authenticate`, `can(actor, 'user.manage')`, иначе `forbidden`. `admin` — `store.listUsers({ orgId: actor.orgId })`, `supervisor` — `store.listUsers({ orgId: query.orgId })`.
- **inviteUser**:
  1. `authenticate`. Роль не `admin` — `forbidden`.
  2. Разобрать `InvitationRequest`.
  3. Лимит `invite:user:<actorId>` (4.10).
  4. `store.findUserByEmail`. Пользователь есть — `mailer.send(alreadyRegisteredMail)` (012, 4.6), ответ `ok`.
  5. Иначе `opaque.create()`, `store.addInvitation({ tokenHash, email, orgId: actor.orgId, role, invitedBy: actor.userId, expiresAt: now + inviteTtl, createdAt: now })`, `mailer.send(inviteMail(link, orgName, hours))`. Ссылка — `${inviteUrl}?token=${token}`.
  6. Лог `info` `user_invited` (`userId` — автор, `orgId`). Ошибка `send` — `mail_unavailable`.
- **acceptInvitation**: разобрать `InvitationAcceptRequest`; лимит `confirm:ip:<ip>`; `hasher.hash(password)`; `store.acceptInvitation({ tokenHash, now, user: { id, passwordHash, createdAt: now } })`. Ответы: `invalid_token` — лог `warn` `invite_invalid_token`; `email_taken`; `ok` — `issueSession(user, org)` из 012.
- **updateUser**:
  1. `authenticate`, `can(actor, 'user.manage')`.
  2. Разобрать `UserUpdate`.
  3. `store.findUserById(userId)`. Нет — `not_found`. `admin` и чужая организация — `not_found`. Цель — сам `actor` или `supervisor` — `forbidden`.
  4. `store.updateUser({ id, role, blockedAt, revokeAt })`: `blocked: true` → `blockedAt = now`; `blocked: false` → `blockedAt = null`; `revokeAt = now`, если блокировка ставится или роль меняется на другую. Без изменений — `revokeAt` не задаётся.
  5. Лог `info` `user_updated` (`userId` — автор, `targetId`, `role`, `blocked`). Вернуть `ManagedUser`.
- **listOrganizations**: `authenticate`, `can(actor, 'organization.read')`, `store.listOrganizations()`.
- **tokenRevocations**: `store.tokenRevocations(now - accessTtlS * 1000)`.
- **purgeExpired**: `store.purge(now - RETENTION_MS)`, лог `info` `identity_purged` с числами из ответа.

Письмо приглашения (константы ядра, как 012, 4.6):
- тема — `Приглашение в Swag`;
- текст — `Вас пригласили в организацию «<orgName>» в Swag. Чтобы задать пароль и войти, откройте ссылку: <link> Ссылка действует N ч.` N — `inviteTtlS / 3600` с округлением вверх (D-113).

`IdentityCoreDeps.settings` дополняется `inviteUrl: string` и `inviteTtlS: number`.

### 4.9. Порт `IdentityStore`: дополнения

```ts
export type StoredUser = {
  // как в 012, плюс:
  blockedAt: number | null;
  tokensValidAfter: number | null;
};

export interface IdentityStore {
  // как в 012, плюс:
  listUsers(filter: { orgId?: string }): Promise<StoredUser[]>; // по email
  updateUser(input: { id: string; role?: Role; blockedAt?: number | null; revokeAt?: number }): Promise<StoredUser>;
  addInvitation(i: { tokenHash: string; email: string; orgId: string; role: OrgRole; invitedBy: string; expiresAt: number; createdAt: number }): Promise<void>;
  acceptInvitation(input: { tokenHash: string; now: number; user: { id: string; passwordHash: string; createdAt: number } }):
    Promise<{ status: 'ok'; user: StoredUser; organization: StoredOrganization } | { status: 'invalid_token' } | { status: 'email_taken' }>;
  listOrganizations(): Promise<(StoredOrganization & { userCount: number })[]>; // по name
  tokenRevocations(since: number): Promise<{ userId: string; validAfter: number; blocked: boolean }[]>; // tokens_valid_after > since
  purge(before: number): Promise<{ confirmations: number; invitations: number; sessions: number }>;
}
```

Правила хранилища:
- **`updateUser`** — одна транзакция. Поля, которые не переданы, не меняются. С `revokeAt`: `tokens_valid_after = revokeAt` и `revoked_at = revokeAt` у всех живых сессий пользователя. Возвращает пользователя после изменения.
- **`acceptInvitation`** — одна транзакция, как `confirmRegistration` 012, 4.3: погасить приглашение (`used_at`) с проверкой срока; email занят — `rollback`, `email_taken`, приглашение не гасится; иначе вставить пользователя с `role`, `org_id` приглашения.
- **`purge`** удаляет: подтверждения и приглашения с `expires_at < before`; сессии с `expires_at < before` или `revoked_at < before`.

Срок хранения `RETENTION_MS` — 7 суток, константа ядра (Q-11). `purgeExpired` вызывает оболочка identity при старте и раз в час.

### 4.10. Лимит приглашений

| Ключ | Лимит | Окно |
|---|---|---|
| `invite:user:<userId>` | 20 | 1 ч |

Константа `RATE_LIMITS` ядра identity, как в 012, 4.8.

### 4.11. Миграция `packages/adapter-postgres/migrations/0004_identity_access.sql`

```sql
-- Up Migration
alter table users add column blocked_at timestamptz;
alter table users add column tokens_valid_after timestamptz;
create index users_tokens_valid_after on users (tokens_valid_after) where tokens_valid_after is not null;
create table invitations (
  token_hash text primary key,
  email text not null,
  org_id uuid not null references organizations (id),
  role text not null check (role in ('user', 'admin')),
  invited_by uuid not null references users (id),
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null
);

-- Down Migration
drop table invitations;
drop index users_tokens_valid_after;
alter table users drop column tokens_valid_after;
alter table users drop column blocked_at;
```

### 4.12. Синхронизация отзывов в `api`

Модуль оболочки `apps/api/src/revocations.ts`:

```ts
export interface RevocationSync {
  start(): Promise<void>;   // первая синхронизация; reject, если не удалась — оболочка повторяет до успеха, listen после
  stop(): void;
  check(claims: AccessTokenClaims): 'ok' | 'revoked' | 'unavailable';
}
export function createRevocationSync(deps: {
  fetchRevocations(): Promise<TokenRevocationList>; // GET {IDENTITY_URL}/internal/token-revocations c IDENTITY_INTERNAL_TOKEN
  onBlocked(userId: string): Promise<void>;          // core.stopSwarmsOfUser + закрытие потоков 4401
  pollMs: number; maxStaleMs: number; now(): number;
  timers: { setInterval; clearInterval };
  log: Logger;
}): RevocationSync;
```

Правила:
1. Каждая успешная синхронизация целиком заменяет таблицу `userId → validAfter`.
2. `check`: последняя удачная синхронизация старше `maxStaleMs` — `unavailable`. Есть запись и `iat * 1000 < validAfter` — `revoked`. Иначе `ok`.
3. Запись `blocked: true` с парой (`userId`, `validAfter`), которой не было в прошлой таблице, вызывает `onBlocked(userId)` один раз. После перезапуска `api` вызов повторяется для всех записей `blocked: true` — это безопасно, `stopSwarmsOfUser` идемпотентна.
4. Ошибка синхронизации — лог `warn` `revocations_sync_failed`, таблица не меняется.

### 4.13. Внутренний токен оркестратора

Оркестратор проверяет `Authorization: Bearer <ORCHESTRATOR_TOKEN>` хуком `onRequest` на всех маршрутах, кроме `GET /health`, через `timingSafeEqual`. Отказ — `401 { error: { code: 'unauthorized' } }`. `@swag/adapter-orchestrator-http` получает токен в опциях и шлёт заголовок.

### 4.14. Конфиг

```ts
const ServiceToken = z.string().min(32); // как GatewayToken

ApiConfig = BaseConfig.extend({
  // как сейчас, плюс:
  IDENTITY_URL: z.string().url(),                 // dev: http://identity:3003
  IDENTITY_INTERNAL_TOKEN: ServiceToken,
  IDENTITY_JWT_PUBLIC_KEY: z.string().min(1),     // base64 от SPKI PEM (D-117)
  IDENTITY_JWT_KID: z.string().min(1),
  ORCHESTRATOR_TOKEN: ServiceToken,
  API_REVOCATION_POLL_MS: z.coerce.number().int().min(1000).default(5000),
  API_REVOCATION_MAX_STALE_MS: z.coerce.number().int().min(1000).default(30000),
});
OrchestratorConfig = /* как сейчас, плюс */ { ORCHESTRATOR_TOKEN: ServiceToken };
IdentityConfig = /* как в 012, плюс */ {
  IDENTITY_INTERNAL_TOKEN: ServiceToken,
  IDENTITY_INVITE_URL: z.string().url(),          // страница UI (014); dev http://127.0.0.1:4200/auth/invite
  IDENTITY_INVITE_TTL_S: z.coerce.number().int().min(600).default(604800),
};
```

- `.env.example` и `.env`: dev-значения `IDENTITY_INTERNAL_TOKEN` и `ORCHESTRATOR_TOKEN` — явно фейковые строки не короче 32 символов, по образцу `LLM_GATEWAY_TOKEN`. `IDENTITY_JWT_PUBLIC_KEY` в `.env.example` пустая.
- `npm run identity:keys -- --write-env` пишет в `.env` обе переменные: `IDENTITY_JWT_PRIVATE_KEY` и `IDENTITY_JWT_PUBLIC_KEY`, в консоль ключи не печатает.
- compose: `api` получает новые переменные и `depends_on: identity (healthy)`; `orchestrator` — `ORCHESTRATOR_TOKEN`; `identity` — новые переменные identity.

### 4.15. Кабинет

- `apps/ui/cabinet/proxy.conf.json`: `/auth` → `http://identity:3003`, без `pathRewrite`. `/internal` не проксируется.
- `@swag/ui-core`, порт и сессия:

```ts
export interface AuthApi {
  login(email: string, password: string): Promise<AuthSession>; // reject с кодом ошибки — неудача
  refresh(): Promise<AuthRefreshed | null>;                      // null — 401
  logout(): Promise<void>;
}
export interface AuthSessionKeeper {
  restore(): Promise<boolean>;           // при старте: refresh по cookie
  login(email: string, password: string): Promise<{ ok: true } | { ok: false; code: string }>;
  logout(): Promise<void>;
  accessToken(): string | null;
  renew(): Promise<boolean>;             // после 401: один refresh на все одновременные запросы
  onSignedOut(listener: () => void): () => void;
}
export function createAuthSessionKeeper(api: AuthApi): AuthSessionKeeper;
```

- `apps/ui/cabinet/src/app/api.ts`: каждый запрос с `Authorization: Bearer`; на `401` — `renew()` и один повтор; неудача — выход на `/login`. Поток открывается с подпротоколами 4.6.
- Страница `/login` (email, пароль, сообщение об ошибке) и кнопка «Выйти». Маршруты роёв защищены guard: нет сессии после `restore()` — `/login`.

## 5. Критерии приёмки

- **AC-024-1** — *Given* `ROLE_PERMISSIONS` *When* `actorFromClaims` для каждой роли и `can` для каждого права *Then* права совпадают с таблицей 4.1, у `supervisor` нет `swarm.create`, `orgId` и `userId` взяты из `org` и `sub`.
- **AC-024-2** — *Given* конфиги 4.14 *When* не задана любая новая обязательная переменная `ApiConfig`, `OrchestratorConfig`, `IdentityConfig` или токен короче 32 символов *Then* `parseConfig` падает с именем переменной; `identity:keys --write-env` пишет обе переменные ключа в файл, а в выводе нет ни одного ключа.
- **AC-024-3** — *Given* Postgres *When* миграция 0004 вверх и вниз *Then* колонки, индекс и таблица 4.11 появляются и исчезают, данные 0003 сохраняются.
- **AC-024-4** — *Given* хранилища в памяти и Postgres (общий набор тестов, как AC-012-30) *When* `listUsers`, `updateUser` с `revokeAt`, `addInvitation`/`acceptInvitation`, `listOrganizations`, `tokenRevocations`, `purge` *Then* результаты совпадают с 4.9; `updateUser` с `revokeAt` отзывает все живые сессии пользователя; принятое приглашение второй раз — `invalid_token`; просроченное — `invalid_token`; занятый email — `email_taken`, приглашение не погашено.
- **AC-024-5** — *Given* Postgres и одна сессия *When* два параллельных `rotateSession` одним старым хэшем *Then* один `ok` и один `reused` (из N-22).
- **AC-024-6** — *Given* заблокированный пользователь *When* вход с верным паролем *Then* `403 user_blocked` и лог `warn` `login_blocked`; с неверным — `401 invalid_credentials`; после разблокировки вход проходит.
- **AC-024-7** — *Given* токен пользователя *When* пользователь заблокирован или его роль изменена *Then* `/auth/me` и маршруты 4.7 с этим токеном — `401`, `refresh` его cookie — `401 invalid_refresh_token`, в `GET /internal/token-revocations` есть запись с `blocked` по случаю; новый вход после смены роли даёт токен с новой ролью и он принимается.
- **AC-024-8** — *Given* две организации и супервизор *When* `GET /auth/users` *Then* `admin` видит только свою организацию при любом `orgId`; `user` — `403`; `supervisor` — всех или одну организацию по `orgId`.
- **AC-024-9** — *Given* администратор *When* `POST /auth/invitations` *Then* `202` и письмо с темой и текстом 4.8 и ссылкой на `IDENTITY_INVITE_URL`; на существующий email — `202` и письмо «аккаунт уже есть» без приглашения; `user` и `supervisor` — `403`; 21-е приглашение за час — `429`.
- **AC-024-10** — *Given* приглашение *When* `POST /auth/invitations/accept` *Then* `201 AuthSession` с ролью приглашения и организацией администратора, cookie 012, 4.5, `no-store`; повтор — `400 invalid_token`.
- **AC-024-11** — *Given* администратор организации A *When* `PATCH /auth/users/:id` *Then* пользователь A — `200 ManagedUser`; пользователь B и несуществующий — `404`; сам себе и супервизору — `403`; тело без полей — `400`; `user` — `403`; супервизор меняет пользователя любой организации — `200`.
- **AC-024-12** — *Given* супервизор *When* `GET /auth/organizations` *Then* `200` со всеми организациями, `userCount` верен; `admin` и `user` — `403`.
- **AC-024-13** — *Given* identity *When* `GET /internal/token-revocations` без токена, с неверным и с верным `IDENTITY_INTERNAL_TOKEN` *Then* `401`, `401`, `200`; в списке нет записей старше `IDENTITY_ACCESS_TTL_S`.
- **AC-024-14** — *Given* просроченные и погашенные подтверждения, приглашения и закрытые сессии старше 7 суток и свежие *When* `purgeExpired` *Then* удалены только старые, лог `info` `identity_purged` с числами.
- **AC-024-15** — *Given* оболочка `api` *When* запрос к каждому маршруту, кроме `/health`, без токена, с битым, просроченным, с чужим `kid` и с отозванным токеном *Then* `401 unauthorized` и лог `warn` `auth_failed` без токена; WebSocket — закрытие `4401`; `/health` — `200` без токена.
- **AC-024-16** — *Given* рои пользователей U1 и U2 организации A и пользователя организации B *When* каждый маршрут роя (`GET /swarms`, `GET /swarms/:id`, `GET /swarms/:id/events`, `POST /swarms/:id/stop`, WebSocket) от U1, U2, администратора A, пользователя B и супервизора *Then* U1 видит только свой рой, администратор A — оба роя A, пользователь B — `404` и пустой список, супервизор — все; рой до 024 виден только супервизору.
- **AC-024-17** — *Given* пользователь A *When* `POST /swarms` *Then* в `swarm.created` записаны `orgId` и `createdBy`; супервизор — `403 forbidden`.
- **AC-024-18** — *Given* рой с событием `llm.call`, у которого `providerCostMicroUsd = 42` *When* события по REST и WebSocket читают администратор и супервизор *Then* администратор получает `null`, супервизор — `42`; в хранилище — `42`.
- **AC-024-19** — *Given* `createRevocationSync` с часами и таймерами в памяти *When* синхронизации проходят, падают и устаревают *Then* `check` даёт `revoked` для `iat * 1000 < validAfter`, `ok` для более позднего, `unavailable` после `maxStaleMs` без удачной синхронизации; `onBlocked` вызван один раз на новую запись `blocked: true`.
- **AC-024-20** — *Given* оболочка `api` *When* первая синхронизация не удалась *Then* `listen` не выполняется до успеха; после устаревания синхронизации маршруты роёв отвечают `503 auth_unavailable`.
- **AC-024-21** — *Given* у пользователя два активных роя и открытый поток *When* синхронизация приносит его блокировку *Then* оба роя остановлены через оркестратор, поток закрыт кодом `4401`, лог `info` `user_swarms_stopped` с `count = 2`; повторная синхронизация роёв не трогает.
- **AC-024-22** — *Given* оркестратор *When* `POST /swarms` и `POST /swarms/:id/stop` без токена и с неверным *Then* `401`, рой не запускается и не останавливается; с верным — как раньше; `/health` без токена — `200`.
- **AC-024-23** — *Given* `createAuthSessionKeeper` с `AuthApi` в памяти *When* `restore`, `login`, три одновременных `renew` и `logout` *Then* `restore` берёт токен по `refresh`; одновременные `renew` делают один `refresh`; неудачный `renew` вызывает `onSignedOut`; `logout` стирает токен.
- **AC-024-24** `[stack]` — *Given* поднятый контур (`STACK_TEST_API_URL`, `STACK_TEST_IDENTITY_URL`, `STACK_TEST_MAILPIT_URL`) *When* регистрация двух компаний, приглашение пользователя в первую и его вход, рой пользователя первой компании, запрос этого роя пользователем второй, вход супервизора, блокировка пользователя администратором *Then* приглашённый входит с ролью `user` и видит свой рой; пользователь второй компании получает `404`; супервизор видит обе организации в `GET /auth/organizations` и рой в `GET /swarms`; после блокировки токен пользователя в `api` даёт `401` не позже чем через `API_REVOCATION_POLL_MS + 1000` мс, вход — `403 user_blocked`; без токена `GET /swarms` — `401` (из S-1, шаги 1, 7–10, на уровне HTTP).
- **AC-024-25** — *Given* логи и спаны в памяти оболочек `api` и identity *When* сценарии AC-024-6…AC-024-21 *Then* в них нет токенов доступа и обновления, токенов приглашения, паролей, внутренних токенов и email.
- **AC-024-26** `[manual]` — *Given* `npm run up` *When* открыть кабинет в браузере *Then* без входа — страница `/login`; вход супервизором из `.env` показывает список роёв; запуск роя недоступен (`403`); выход возвращает на `/login`; вход администратором организации, созданной через `curl`, — запуск и просмотр роя работают, поток событий идёт. Проверка — шаги и результат в журнал.

## 6. Нефункциональные требования

| ID | Требование | Как измеряется |
|---|---|---|
| NFR-024-1 | Блокировка действует в `api` не позже чем через `API_REVOCATION_POLL_MS + 1000` мс | AC-024-24 на поднятом контуре, время — в журнал |
| NFR-024-2 | Проверка токена добавляет к p95 `GET /swarms/:id` не больше 5 мс | 200 запросов через `app.inject` с проверкой и без под `API_BENCH=1`, цифры — в журнал |

## 7. Безопасность: что не должно сломаться

- Без токена доступны только `/health`, регистрация, подтверждение, вход, обновление, выход и принятие приглашения → AC-024-15, AC-024-24.
- Чужой рой, его события и поток недоступны и не выдают своего существования → AC-024-16.
- Заблокированный пользователь не работает ни одним токеном, его рои стоят → AC-024-6, AC-024-7, AC-024-21, AC-024-24.
- Отзыв нельзя обойти падением identity: без свежей синхронизации `api` отказывает → AC-024-19, AC-024-20.
- Администратор не управляет чужой организацией, собой и супервизором → AC-024-11.
- Маржа платформы не видна организациям → AC-024-18.
- Песочница не управляет роями через оркестратор → AC-024-22.
- Внутренний список отзывов не доступен без токена и не проксируется UI → AC-024-13.
- Токены, пароли и email не попадают в логи → AC-024-25.
- Агент и песочница по-прежнему не получают токен пользователя: 024 не меняет env песочницы → AC-022-17 остаётся зелёным.

## 8. Задачи для агента

Выполняются по порядку. После каждой задачи — коммит.

- [x] **T-1.** `packages/contracts`: файл `src/access.ts` (4.1) и дополнения `src/auth.ts` (4.2), экспорт из `index.ts`, тесты `test/access.test.ts`. Закрывает: REQ-024-1, AC-024-1. Готово, когда: тесты пакета зелёные.
- [x] **T-2.** `packages/contracts/src/events.ts` (`swarm.created`, 4.3) и `packages/api-integration/src/swarm-view.ts` (`orgId`, `createdBy`), тесты проекции на событие с полями и без. Закрывает: REQ-024-4 (часть). Готово, когда: тесты обоих пакетов и `apps/ui/cabinet` компилируются и зелёные.
- [x] **T-3.** `packages/config`: `ServiceToken`, новые переменные `ApiConfig`, `OrchestratorConfig`, `IdentityConfig` (4.14), тесты; `.env.example` и `.env`; `scripts/identity-keys.ts` пишет обе переменные ключа. Закрывает: AC-024-2. Готово, когда: тесты `config` и скрипта зелёные.
- [x] **T-4.** Миграция `packages/adapter-postgres/migrations/0004_identity_access.sql` (4.11) и тест миграции. Закрывает: AC-024-3.
- [x] **T-5.** `packages/identity-core`: типы и порт 4.9 (без операций), `packages/adapter-memory`: реализация новых методов `createMemoryIdentityStore`, общий набор тестов хранилища `identity-store.contract.ts` дополнен сценариями 4.9. Закрывает: AC-024-4 (память).
- [x] **T-6.** `packages/adapter-postgres`: новые методы `createPostgresIdentityStore` по правилам 4.9, общий набор тестов на Postgres, тест гонки `rotateSession` (из N-22). Закрывает: AC-024-4, AC-024-5.
- [x] **T-7.** `packages/identity-core`: `authenticate`, блокировка в `login` и `refresh`, `me` через `authenticate`, `listUsers`, `listOrganizations`. Закрывает: REQ-024-7 (часть), REQ-024-8 (часть), AC-024-6, AC-024-7 (ядро), AC-024-8 (ядро), AC-024-12 (ядро).
- [x] **T-8.** `packages/identity-core`: `inviteUser`, `acceptInvitation`, письмо приглашения, лимит 4.10. Закрывает: REQ-024-6, AC-024-9 (ядро), AC-024-10 (ядро).
- [x] **T-9.** `packages/identity-core`: `updateUser`, `tokenRevocations`, `purgeExpired` (из N-20). Закрывает: REQ-024-7, REQ-024-8, REQ-024-12, AC-024-11 (ядро), AC-024-14.
- [x] **T-10.** `apps/identity`: маршруты 4.7, проверка `IDENTITY_INTERNAL_TOKEN`, уборка при старте и раз в час, новые настройки в `start.ts`, тесты маршрутов. Закрывает: AC-024-6…AC-024-13 (HTTP), AC-024-25 (identity).
- [x] **T-11.** `packages/api-core`: `Actor` в операциях 4.4, видимость, права, владелец в `swarm.created`, скрытие `providerCostMicroUsd`, `stopSwarmsOfUser`; правка вызовов в тестах ядра. Закрывает: REQ-024-3, REQ-024-4, REQ-024-5, REQ-024-10 (ядро), AC-024-16 (ядро), AC-024-17, AC-024-18 (ядро).
- [x] **T-12.** `apps/api/src/revocations.ts` (4.12) и тесты. Закрывает: REQ-024-9, AC-024-19.
- [x] **T-13.** `apps/api`: хук проверки токена, `Actor` в вызовах ядра, WebSocket с подпротоколом 4.6, статусы 4.5, запуск синхронизации до `listen`, `onBlocked` с закрытием потоков, тесты доступа на каждый маршрут. Закрывает: REQ-024-2, REQ-024-9, REQ-024-10, AC-024-15, AC-024-16, AC-024-18, AC-024-20, AC-024-21, AC-024-25 (api), NFR-024-2.
- [x] **T-14.** Оркестратор: хук `ORCHESTRATOR_TOKEN` в `apps/orchestrator`, токен в `@swag/adapter-orchestrator-http`, передача из `apps/api`. Закрывает: REQ-024-11, AC-024-22.
- [ ] **T-15.** `packages/ui-core`: `AuthApi`, `createAuthSessionKeeper` (4.15) и тесты. Закрывает: REQ-024-13 (ядро), AC-024-23.
- [ ] **T-16.** `apps/ui/cabinet`: прокси `/auth`, адаптер `AuthApi`, Bearer и `renew` в `api.ts`, подпротоколы потока, страница `/login`, guard, кнопка «Выйти». Закрывает: REQ-024-13. Готово, когда: сборка кабинета зелёная.
- [ ] **T-17.** compose (4.14), `apps/api/test/stack.test.ts` по AC-024-24 с замером NFR-024-1, `STACK_TEST_API_URL` в `.env.example` и `.env`, отметка у S-1 в `docs/spec/scenarios.md`, ручная проверка AC-024-26 с выводом в журнал. Закрывает: AC-024-24, AC-024-26, NFR-024-1.
- [ ] **T-18.** `docs/architecture.md` (раздел «Доступ» — по факту кода), сверка глоссария, README затронутых пакетов, корневой README. Готово, когда: README сверены с кодом.

## 9. Открытые вопросы

Пока список не пуст, спека не может быть `ready`. Агент дописывает сюда вопросы при `blocked`.

- [x] **Q-1. Что видит пользователь и администратор организации.** *(из D-10, часть «видимость»; Claude, 2026-10-31)*
  - а) `user` — только свои рои; `admin` — все рои организации целиком, с перепиской и событиями; `supervisor` — все;
  - б) `user` видит все рои организации;
  - в) `admin` видит у чужих роёв только расходы.

  **Рекомендация: «а».** Роадмап даёт администратору «рои и расходы по пользователям», а без переписки он не разберётся, на что ушли деньги. Пользователь не видит чужую работу коллег, пока это не понадобилось: расширить видимость проще, чем сузить. Деньги D-10 (чей баланс, кто пополняет) остаются для 013.

  **Ответ (человек, 2026-10-31):** по рекомендации.

- [x] **Q-2. Как перестают приниматься токены заблокированного.** *(Claude, 2026-10-31)*
  - а) identity ведёт список отзывов (`tokens_valid_after`), `api` забирает его раз в 5 с по внутреннему токену и отказывает, если синхронизация старше 30 с;
  - б) ждать истечения токена доступа (до 15 мин), отзывать только сессии;
  - в) событие блокировки по NATS;
  - г) запрос в identity на каждый запрос `api`.

  **Рекомендация: «а».** Критерий 11 требует, чтобы токены перестали приниматься, а «б» оставляет их живыми на 15 минут. Шина до 007 открыта песочницам: агент может подделать или подавить событие, поэтому «в» небезопасно. «г» противоречит принципу «токен проверяется без запроса в identity» и делает identity точкой отказа на каждый запрос. Список маленький: только пользователи, изменённые за последние 15 минут.

  **Ответ (человек, 2026-10-31):** по рекомендации.

- [x] **Q-3. Как администратор добавляет пользователя.** *(Claude, 2026-10-31)*
  - а) приглашение письмом: пользователь сам задаёт пароль по ссылке, срок ссылки 7 суток;
  - б) администратор задаёт временный пароль и передаёт его сам.

  **Рекомендация: «а».** Пароль знает только пользователь, и подтверждается владение email. Механизм тот же, что у подтверждения регистрации 012. Неделя — обычный срок приглашения: сотрудник может открыть письмо не в тот же день.

  **Ответ (человек, 2026-10-31):** по рекомендации.

- [x] **Q-4. Роли через API и супервизор.** *(Claude, 2026-10-31)*
  - администратор выдаёт роли `user` и `admin` в своей организации, но не себе;
  - супервизор делает то же с любым пользователем, кроме супервизоров; новые супервизоры — только из `.env`;
  - супервизор не создаёт рои: у него нет организации, а с 013 рой оплачивает организация.

  **Рекомендация: так.** Запрет менять себя не даёт администратору случайно оставить организацию без администратора. Супервизор через API — самая опасная роль, поэтому её выдача остаётся ручной.

  **Ответ (человек, 2026-10-31):** по рекомендации.

- [x] **Q-5. Ответ на чужие данные.** *(Claude, 2026-10-31)*
  а) `404 not_found`, как на несуществующий; б) `403 forbidden`.

  **Рекомендация: «а».** `403` подтверждает, что рой с таким id существует. `403` остаётся для случая, когда у роли нет права вообще (супервизор и `POST /swarms`).

  **Ответ (человек, 2026-10-31):** по рекомендации.

- [x] **Q-6. Токен в WebSocket.** *(Claude, 2026-10-31)*
  а) в подпротоколе `swag.bearer.<jwt>`; б) в параметре адреса `?access_token=`; в) первым сообщением после подключения.

  **Рекомендация: «а».** Браузер не даёт задать заголовок у WebSocket. Адрес с токеном попадает в логи прокси и Fastify. Первое сообщение требует отдельного протокола и таймаута ожидания. Подпротокол — заголовок `Sec-WebSocket-Protocol`, его логи не пишут, а символы JWT в нём допустимы.

  **Ответ (человек, 2026-10-31):** по рекомендации.

- [x] **Q-7. Кабинет до спеки 014.** *(Claude, 2026-10-31)*
  а) в 024 — страница входа и сессия в кабинете, логика сессии в `ui-core`, 014 переносит её в каркас; б) флаг, который отключает проверку токена в `api` до 014.

  **Рекомендация: «а».** Иначе после 024 кабинет перестаёт работать. Флаг отключения доступа опасен: его можно забыть в проде. Логика сессии в `ui-core` не выбрасывается в 014, переносится только страница.

  **Ответ (человек, 2026-10-31):** по рекомендации.

- [x] **Q-8. Фактическая стоимость у провайдера.** *(из D-38, часть «Кто видит фактическую стоимость»; Claude, 2026-10-31)*
  `providerCostMicroUsd` событий `llm.call` отдаётся только супервизору, остальным — `null`, в хранилище поле не меняется.

  **Рекомендация: так**, как и записано в D-38. Иначе организация видит маржу платформы. Остальная часть D-38 (остаток у провайдеров, поступления) остаётся для 013, 025 и 014.

  **Ответ (человек, 2026-10-31):** по рекомендации.

- [x] **Q-9. Внутренний токен оркестратора.** *(Claude, 2026-10-31)*
  а) включить в 024: `ORCHESTRATOR_TOKEN`, как `LLM_GATEWAY_TOKEN` у gateway; б) отложить до 005 (сеть на рой).

  **Рекомендация: «а».** Песочницы до 005 стоят в общей сети compose, и агент может вызвать `POST /swarms/:id/stop` чужого роя напрямую. Проверка доступа в `api` без этого обходится. Правка маленькая: хук и заголовок.

  **Ответ (человек, 2026-10-31):** по рекомендации.

- [x] **Q-10. Уборка и гонка из бэклога.** *(из N-20 и N-22; Claude, 2026-10-31)*
  Взять в 024 уборку просроченных записей identity (T-9, T-10) и тест гонки `rotateSession` (T-6).

  **Рекомендация: взять.** Обе правки в тех же пакетах, что и спека, и вместе меньше одной задачи. Уборка нужна сейчас: появляются приглашения и отзыв сессий при каждой блокировке.

  **Ответ (человек, 2026-10-31):** по рекомендации.

- [x] **Q-11. Числа.** *(Claude, 2026-10-31)*
  Опрос отзывов — 5 с, допустимая давность синхронизации — 30 с, срок приглашения — 7 суток, лимит приглашений — 20 в час на администратора, срок хранения закрытых записей — 7 суток, уборка — раз в час.

  **Рекомендация: так.** 5 с — заметная пользователю задержка блокировки и одна маленькая выборка в identity раз в 5 с. 30 с — шесть пропущенных опросов: переживает перезапуск identity и не держит отозванные токены долго. 20 приглашений в час хватает на подключение отдела и ограничивает рассылку с украденного администратора.

  **Ответ (человек, 2026-10-31):** по рекомендации.

## 10. Журнал реализации

Заполняет агент.

| Дата | Ветка / коммит | Что сделано | Отклонения от спеки |
|---|---|---|---|
| 2026-10-31 | `spec/024-t1` | Взята в работу. Этапы: T-1+T-2; T-3; T-4; T-5+T-6; T-7; T-8; T-9; T-10; T-12; группа T-11+T-13 через фича-ветку `spec/024-api` (T-11 меняет сигнатуры `ApiCore`, оболочка `apps/api` компилируется только после T-13); T-14; T-15; T-16; T-17; T-18 и завершение. | — |
| 2026-10-31 | `spec/024-t1`, `5b26c80`, `b477e45` | T-1: `contracts/src/access.ts` (4.1), схемы 4.2 в `auth.ts`, тесты AC-024-1 (`packages/contracts/test/access.test.ts`). T-2: `orgId`, `createdBy` в `swarm.created` и `SwarmView` (отсутствующее — `null`), тесты REQ-024-4 в `packages/api-integration/test/swarm-view.test.ts`. README `contracts`, `api-integration`; `not_found` в глоссарии. | Вынужденная правка вне файлов T-1: записи `forbidden` 403, `not_found` 404, `user_blocked` 403 в `STATUS` `apps/identity/src/app.ts` и тексты в `MESSAGES` `identity-core` — карты исчерпывающие по `AuthErrorCode`, без них не компилируется. |
| 2026-10-31 | `spec/024-t3`, `e60d49d` | T-3: `ServiceToken` (переименован `GatewayToken`, одна схема на внутренние токены), переменные 4.14 в `ApiConfig`, `OrchestratorConfig`, `IdentityConfig`; `.env.example` и `.env`; `identity:keys --write-env` пишет обе переменные ключа. Тесты AC-024-2: `packages/config/test/config.test.ts`, `scripts/identity-keys.test.ts`. README `config`, корневой. | Локальный `.env`: пара ключей identity перегенерирована (раньше не было публичного), ранее выданные dev-токены недействительны. Compose — в T-17. |
| 2026-10-31 | `spec/024-t4`, `8110641`, `14ac223`, последний коммит этапа (T-6) | T-4: миграция `0004_identity_access.sql` дословно по 4.11; тест AC-024-3 в `packages/adapter-postgres/test/migrations.test.ts` (вверх, вниз через `runner` с `count: 1`, данные 0003 сохраняются). T-5: порт 4.9 и `RETENTION_MS` в `packages/identity-core/src/index.ts`; `createMemoryIdentityStore` — новые методы; сценарии AC-024-4 в `packages/adapter-memory/test/identity-store.contract.ts` (`listUsers`, `updateUser`, приглашения, `listOrganizations`, `tokenRevocations`, `purge`). T-6: методы 4.9 в `createPostgresIdentityStore` (`updateUser` и `acceptInvitation` одной транзакцией, маппинг `blocked_at`/`tokens_valid_after`); AC-024-4 на Postgres через общий набор; AC-024-5 — `packages/adapter-postgres/test/identity-store.test.ts` (5 раундов параллельных `rotateSession`: `ok` и `reused`). Тесты с `.env` (`packages/adapter-postgres packages/adapter-memory packages/identity-core`): 118 passed, 2 skipped (бенчи без `POSTGRES_BENCH=1`); `npm run check` без `.env` — зелёный. README `identity-core`, `adapter-memory`, `adapter-postgres` переписаны по факту. Глоссарий: `RETENTION_MS`, `addInvitation`, `tokensValidAfter`, `tokens_valid_after`. | Вынужденные правки вне файлов задач и трактовки: (1) `migrations.test.ts`: AC-003-1 — число миграций 3 → 4; AC-004-20 — ожидаемые колонки `users` и таблица `invitations`; `runner` с `advisoryLockMode: 'wait'` (параллельные файлы тестов). (2) Тестовые фикстуры `StoredUser` (`identity-core/test/*`, `apps/identity/test/start.test.ts`, `adapter-postgres/test/identity-store.test.ts`) получили `blockedAt: null`, `tokensValidAfter: null`; ядро передаёт их `null` при регистрации и создании супервизора. (3) `rotateSession` 012 не менялся: гонка из N-22 закрыта `for update` и повтором по `previous_hash`, тест проходит. (4) Трактовки: `updateUser` с неизвестным `id` бросает `Error` (4.9 не описывает ошибку); порядок `listUsers`/`listOrganizations` — по `email`/`name` в памяти JS, в Postgres — по collation базы, тесты сравнивают только ASCII-имена; `purge` в тесте — `before = 0` с отрицательными временами, чтобы не задеть записи других тестов общей схемы; отзыв при `revokeAt` — все сессии с `revoked_at is null`, включая уже просроченные (как в 4.9). (5) Co-Authored-By в коммитах этапа — строка из `rules024.md` (Opus); системная подсказка указывает Haiku 5.5 — проверить до PR. |
| 2026-10-31 | `spec/024-t7`, коммит этапа (T-7) | `authenticate` (внутренняя): токен и отзыв, роль и организация из хранилища, `Actor` через `actorFromClaims`; `me` через `authenticate` (ответ как в 012); блокировка в `login` (после верного пароля — `user_blocked`, лог `warn` `login_blocked` с `userId`) и в `refresh` (`invalid_refresh_token`); `listUsers` и `listOrganizations` с маппингом `ManagedUser` и `OrganizationSummary`. Тесты `packages/identity-core/test/access.test.ts`: AC-024-6 (блокировка, неверный пароль, разблокировка), AC-024-7 (блокировка с `revokeAt` и без него, смена роли с `revokeAt`, роль из хранилища), AC-024-8 (ядро: admin своей организации, `user` — `forbidden`, supervisor — все или по `orgId`, сортировка по email), AC-024-12 (ядро). README `identity-core` переписан по факту, `authenticate` добавлен в глоссарий. | Трактовки: (1) `authenticate` возвращает не только `Actor`, но и пользователя с организацией: `me` нужны email и название, а 4.8 описывает только `Actor`. (2) `admin` с `orgId: null` в `listUsers` — `forbidden`, а не выборка всех пользователей (контракт такого админа не допускает). (3) `refresh` заблокированного: сессия уже повёрнута до проверки блокировки, ответ — `invalid_refresh_token`; при `revokeAt` сессии отзывает хранилище. (4) `iat` есть в `AccessTokenClaims` верификатора, вопрос по 4.8 не возник. (5) Co-Authored-By в коммите — строка системной подсказки (Haiku 5.5), а не `rules024.md` (Opus 5.5): расхождение, проверить до PR. |
| 2026-10-31 | `spec/024-t8`, `5b026e4` (T-8), коммит T-9 (последний на ветке) | T-8: `inviteUser` (`authenticate`, роль `admin`, разбор `InvitationRequest`, лимит `invite:user` 20 за 1 ч по `userId` автора, существующий email — письмо «аккаунт уже есть», иначе `addInvitation` и письмо `INVITATION_MAIL_SUBJECT` / `invitationMailText`, лог `user_invited`); `acceptInvitation` (лимит `confirm:ip`, хэш, `store.acceptInvitation`, `invite_invalid_token`, `email_taken`, сессия через `issueSession`); `IdentityCoreDeps.settings` += `inviteUrl`, `inviteTtlS`. T-9: `updateUser` (4.8, пункты 1–5, лог `user_updated`), `tokenRevocations` (окно `accessTtlS`), `purgeExpired` (`RETENTION_MS`, лог `identity_purged`). Тесты: AC-024-9, AC-024-10 — `test/invitation.test.ts`; AC-024-11 и `tokenRevocations` — `test/management.test.ts`; AC-024-14 — `test/purge.test.ts`. Хелперы `seedOrganization`, `addMember`, `loginAs` вынесены из `access.test.ts` в `test/fakes.ts`. Глоссарий: `invite_invalid_token`, `INVITATION_MAIL_SUBJECT`, `invitationMailText`, `user_updated`. README `identity-core` по факту. | Трактовки: (1) настройки `inviteUrl`/`inviteTtlS` передаются в `apps/identity/src/main.ts` (там собираются настройки ядра из конфига), `start.ts` получает готовые deps; тестовые `support.ts` и `start.test.ts` дополнены, маршрутов не трогал. (2) Противоречие 4.8 и AC-024-11: админ, меняющий супервизора, по порядку 4.8 получил бы `not_found` (чужая организация), AC требует `403`. Проверка «сам себе или супервизор → forbidden» стоит раньше проверки организации. Нужен ответ по спеке. (3) `blocked: true` у уже заблокированного: `blockedAt = now` буквально по 4.8, `revokeAt` не задаётся. (4) `user_invited` пишется только после успешной отправки письма. (5) Co-Authored-By в коммитах: `rules024.md` задаёт Claude Opus 5.5, системная подсказка — Haiku 5.5; взят вариант из `rules024.md`, расхождение проверить до PR. |
| 2026-10-31 | `spec/024-t10`, коммит T-10 | T-10: маршруты 4.7 в `apps/identity/src/app.ts`: `GET /auth/users` (`listUsers`), `POST /auth/invitations` (202, пустое тело), `POST /auth/invitations/accept` (201 `AuthSession`, cookie 012, `no-store`), `PATCH /auth/users/:id` (200 `ManagedUser`), `GET /auth/organizations`; `GET /internal/token-revocations` с `timingSafeEqual` (как в gateway, разная длина — отказ без сравнения), `401 unauthorized` без токена и с неверным. Уборка: `purgeExpired` в `onReady` и раз в час (`setInterval`, `unref`), таймер снимается в `onClose`; сбой — `warn` `identity_purge_failed` без текста ошибки. `IDENTITY_INTERNAL_TOKEN` передаётся через `AppSettings.internalToken` из `main.ts`. Тесты: AC-024-6, 7 — `apps/identity/test/blocking.test.ts`; AC-024-8, 11, 12 — `management.test.ts`; AC-024-9, 10 — `invitation.test.ts`; AC-024-13 — `revocations.test.ts`; AC-024-25 (identity) — `access-logs.test.ts`; уборка при старте и сбой — `purge.test.ts`. `telemetryText` вынесен в `support.ts` (общий с `logs.test.ts`). README `apps/identity` и глоссарий (`identity_purge_failed`) по факту. | Трактовки: (1) `start.ts` не менялся: токен и настройки уборки идут через `buildApp`, настройки приглашения уже в `main.ts`. (2) `GET /auth/users?orgId=` — если `orgId` не строка (повтор параметра), он не передаётся: супервизор видит всех. (3) Буквальное `iat * 1000 < validAfter` (4.8) отклоняет вход в ту же секунду после `revokeAt`, окно до 1 с; тесты сдвигают часы на 1 с. Вопрос к спеке: нужен ли допуск. (4) Co-Authored-By в коммите — Haiku 5.5 по системной подсказке; `rules024.md` задаёт Opus 5.5 — расхождение проверить до PR. |
| 2026-10-31 | `spec/024-t12`, коммит T-12 | T-12: `apps/api/src/revocations.ts` по 4.12 — `createRevocationSync` (`start`, `stop`, `check`), таблица `userId → validAfter` целиком заменяется удачной синхронизацией; `check` даёт `unavailable` (нет удачной синхронизации или старше `maxStaleMs`), `revoked` (`iat * 1000 < validAfter`) или `ok`; `onBlocked` по карте обработанных пар `handled` (`userId → validAfter`): пара повторяется, пока не пройдёт, параллельно через `Promise.allSettled`; сбой синхронизации — `warn` `revocations_sync_failed`; параллельные тики пропускаются; `start` без второго интервала, `stop` до `start` безопасен, `stop` во время синхронизации отменяет её вызовы. Модуль в `main.ts` не подключён (T-13). Тесты `apps/api/test/revocations.test.ts`: AC-024-19 (16 тестов с фейковыми часами и таймерами). README `apps/api`, глоссарий (`revocations_sync_failed`, `revocation_block_failed`). | Трактовки: (1) «`onBlocked` повторяется на следующей синхронизации, пока не пройдёт (карта обработанных пар); при успехе — один раз на пару, как в 4.12; повтор безопасен — `stopSwarmsOfUser` идемпотентна (4.4 п.6). Зависший `onBlocked` держит синхронизацию: таймаут вызовов оркестратора — в T-13.» Сбой `onBlocked` — `warn` `revocation_block_failed` с `userId` без текста ошибки; (2) `start` при неудаче reject с `Error('revocations sync failed')` — текст только для вызывающего, в лог не пишется; (3) Co-Authored-By — строка из `rules024.md` (Opus 5.5), системная подсказка указывает Haiku 5.5: расхождение, как в T-7, проверить до PR. |
| 2026-10-31 | `spec/024-t11` (коммит T-11, последний на ветке этапа; группа T-11+T-13 через фича-ветку `spec/024-api`) | T-11: `packages/api-core/src/index.ts` — все операции с данными роя принимают `actor` первым аргументом (4.4); `visible(actor, view)` (правило 1, сравнение с `?? null`); `not_found` с прежним текстом (правило 2); `forbidden` до разбора тела (правило 3); `orgId` и `createdBy` из `actor` в `swarm.created` (правило 4); `providerCostMicroUsd` = `null` в `getEvents` и `subscribe` для не супервизора, хранилище не меняется (правило 5); `stopSwarmsOfUser` (правило 6, лог `user_swarms_stopped`). Тесты `packages/api-core/test/api-core.test.ts`: AC-024-16 (ядро), AC-024-17, AC-024-18 (ядро), AC-024-21 (ядро, REQ-024-10); правило 3 — тест «без права — forbidden» под AC-024-16. Существующие тесты переведены на `ACTOR` (пользователь организации A), проверки не ослаблены. README `api-core` переписан по факту, глоссарий: `visible`. Результат: `npx vitest run packages/api-core` — 30 passed; `npx tsc -p packages/api-core --noEmit` и eslint/prettier по изменённым файлам — без ошибок. `apps/api` не компилируется до T-13 (ожидаемо): `npm run typecheck` — 7 ошибок в `apps/api/src/app.ts`, 20 в тестах `apps/api/test` (api, e2e, trace); ошибок вне `apps/api` нет. | Трактовки: (1) `listSwarms` без `swarm.read` возвращает пустой список, а не `forbidden`: сигнатура 4.4 без `Result`; у всех ролей есть право (4.1), эффекта на текущих ролях нет. (2) AC-024-16 «пользователь B — 404 и пустой список»: пустой список относится к роям U1 и U2; собственный рой B виден по правилу 1, его `listSwarms` — только он. (3) Сбой остановки одного роя логируется `user_swarm_stop_failed`, остальные останавливаются, вызов бросает `AggregateError` — `onBlocked` повторится при следующей синхронизации. (4) Порядок проверок: право → видимость → состояние. (5) Co-Authored-By — строка из `rules024.md` (Opus 5.5); системная подсказка указывает Haiku 5.5: расхождение, как в T-7, проверить до PR. |
| 2026-10-31 | `spec/024-api` (фича-ветка группы T-11+T-13), `spec/024-t13`, коммит T-13 | T-13: `apps/api`. Хук `onRequest` (`src/app.ts`, дочерний плагин) на всех REST-маршрутах, кроме `/health` и WebSocket: `Authorization: Bearer` → `createAuthenticator` (`src/auth.ts`: `verifier.verify` → `revocations.check` → `actorFromClaims`), `request.actor` во всех вызовах ядра; `401 unauthorized` / `503 auth_unavailable`, `warn auth_failed` с `reason` без токена; `STATUS` += 401/403/503. WebSocket: подпротокол `swag.v1` (`handleProtocols`), токен из `swag.bearer.<jwt>` при подключении, отказ — закрытие `4401`, нет права/невидим — `4404`; потоки по `userId` (`src/streams.ts`, `createStreamRegistry`), `createBlockHandler` — `stopSwarmsOfUser` и закрытие потоков в `finally`. `src/main.ts`: `createJoseVerifier` по `IDENTITY_JWT_PUBLIC_KEY` (base64 от SPKI PEM), `fetchTokenRevocations` (`GET {IDENTITY_URL}/internal/token-revocations`, таймаут `IDENTITY_TIMEOUT_MS` = 3000 мс), `startServer` (`src/start.ts`): `start()` с повтором через `API_REVOCATION_POLL_MS`, затем `listen`; при остановке — `revocations.stop()`. В `api-core` удалять нечего: дубль строки `user_swarms_stopped` в T-11 не обнаружен. Тесты: `apps/api/test/access.test.ts` — AC-024-15 (`it('AC-024-15: …')`), AC-024-16 (матрица по пяти акторам × REST и WebSocket), AC-024-18, AC-024-20 (`startServer` с падением identity, устаревание → 503), AC-024-21 (два роя, поток 4401, `count: 2`, повтор не трогает), AC-024-25 (логи после отказов, WebSocket и блокировки без токенов и `@`), блокировка при падении остановки; `bench.test.ts` — NFR-024-2. Существующие тесты `api`, `e2e`, `trace`, `history`, `health` переведены на токены и `Actor`. Бенч (`API_BENCH=1`, 200 запросов `GET /swarms/:id`, два прогона): с проверкой p95 0.435 и 0.408 мс; без проверки p95 0.100 и 0.069 мс; разница p95 0.336 и 0.339 мс (порог 5 мс). | Отклонения и трактовки (вопросы в `questions.md`): **D-123** — при `unavailable` WebSocket закрывается `4401` (4.6 даёт его для отказа токена), лог `auth_failed` с `reason: unavailable` (4.5 перечисляет три причины). **D-124** — у `orchestrator.stop` при блокировке нет таймаута, спека его не задаёт. Таймаут identity — константа `IDENTITY_TIMEOUT_MS` в `main.ts`, не переменная (4.14 её не перечисляет). `buildApp` получает третьим аргументом `AppAuth` (`authenticate`, `streams`). Бенч «без проверки» — тот же маршрут и хук с `authenticate`, возвращающим фиксированный `Actor`. AC-024-25 (api) по спанам: `tracedHttpServer` пишет только `http.request.method` и `url.path`, заголовки не попадают. **Замечания ревью (коммит «fix: spec:024 T-13 замечания ревью»):** (a) поток освобождается при `close`/`error`, вешаемых до проверки токена; после неё при закрытом сокете поток не регистрируется и не подписывается — тест `AC-024-21` в `access.test.ts` (поток закрыт во время проверки). (b) `HEAD` на GET-маршрутах без токена → 401; неизвестный путь и `OPTIONS` без токена → 404, без данных роя в теле (трактовка: неизвестные пути и OPTIONS отвечают 404 без токена — данных нет, хук стоит на маршрутах роёв); обычный GET на путь потока без апгрейда данных роя не отдаёт — `AC-024-15`. (c) `AC-024-20`: при `unavailable` все маршруты роёв → `503 auth_unavailable`, WebSocket → 4401 (D-123). (d) `AC-024-25`: сбой и успех настоящего `fetchTokenRevocations` против фейкового identity (500, затем 200); внутренний токен не попадает в лог; спаны REST и WebSocket с `Authorization` и `swag.bearer.<jwt>` не содержат токена (тест с in-memory экспортёром `@swag/adapter-telemetry`). (e) `fetchTokenRevocations` собирает адрес через `new URL('/internal/token-revocations', baseUrl)`: хвостовой `/` не даёт `//`; `new URL` отбрасывает путь из `IDENTITY_URL`: сейчас это origin (`.env.example`: `http://identity:3003`), но префикс пути в URL не поддержан. (f) клиент без `swag.v1` получает отказ рукопожатия **1006**, а не 4401: `ws` на `handleProtocols` → `false` не отвечает ошибкой, а принимает апгрейд без `Sec-WebSocket-Protocol`, и клиент рвёт соединение сам (проверено тестом `AC-024-15`). Сервер при этом сам обрывает сокет без `swag.v1` (`terminate`) до проверки токена, поток не регистрируется (сначала сокет оставался открытым до закрытия TCP — исправлено при ревью). Тест завершает сокет вручную. Решение — отдельный вопрос к спеке 4.6 (отклонять апгрейд без `swag.v1` до `101`, например через `verifyClient`), в коде не меняли. |
| 2026-10-31 | `spec/024-t14`, коммит T-14 | T-14: `apps/orchestrator/src/app.ts` — хук `onRequest` на всех маршрутах, кроме `GET /health`: `Authorization: Bearer <ORCHESTRATOR_TOKEN>` через `timingSafeEqual`, отказ `401 { error: { code: 'unauthorized', message } }` до разбора тела и до ядра; `buildApp(core, options, { token })`, токен из `OrchestratorConfig` в `main.ts`. `@swag/adapter-orchestrator-http`: опция `token`, заголовок на каждом запросе; `apps/api/src/main.ts` передаёт `ORCHESTRATOR_TOKEN`. Сравнение вынесено в `@swag/helpers/server` (`tokenMatches`, `bearerMatches`) и заменило по одной копии в `apps/identity` и `apps/llm-gateway` (DRY). Тесты: AC-024-22 — `apps/orchestrator/test/auth.test.ts` (401 без токена и с неверным, ядро не вызвано; 202/404 с верным; `/health` — 200), `packages/adapter-orchestrator-http/test/client.test.ts` (заголовок на `launch` и `stop`), `packages/helpers/test/token.test.ts` (`bearerMatches`, `tokenMatches`). Тест трассировки `apps/api/test/trace.test.ts` (AC-016-9) получил тестовый токен. README `apps/orchestrator`, `packages/adapter-orchestrator-http`, `packages/helpers`, `apps/api`, `apps/identity`, `apps/llm-gateway` и глоссарий по факту. | Трактовки: (1) `buildApp` оркестратора получил третий аргумент `settings` (как `apps/api`), `options` стал обязательным. (2) Неизвестный путь без токена отвечает `401`, а не `404` (хук смотрит `routeOptions.url`). (3) Вынос в helpers: `@swag/helpers/server` получил `/// <reference types="node" />` только для `node:crypto`, глобальный `types` в `tsconfig` helpers не менялся. (4) Сообщение ошибки `Invalid orchestrator token` — по образцу `llm-gateway`; в спеке задан только код. (5) Co-Authored-By в коммите — Claude Opus 5.5 по `rules024.md`; системная подсказка указывает Claude Haiku 5.5, расхождение проверить до PR. |
| 2026-10-31 | `spec/024-t14` | Примечание ревью: `compose.yaml` ещё не передаёт новые переменные 4.14 (`ApiConfig` требует их с T-3, `ORCHESTRATOR_TOKEN` — с T-14), поэтому `npm run up` на свежих образах не стартует `api` и `orchestrator` до T-17, где compose дополняется по 4.14. | — |
