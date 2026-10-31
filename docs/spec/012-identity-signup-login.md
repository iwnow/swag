---
id: "012"
title: Регистрация и вход
status: in-progress
roadmap_stage: 5
depends_on: ["000", "003", "016"]
superseded_by: null
updated: 2026-10-31
---

# 012. Регистрация и вход

> **Коротко.**
> - Появляется сервис **identity**: `apps/identity` и ядро `identity-core`. Компания регистрируется сама. Она вводит email и получает письмо со ссылкой. По ссылке задаёт пароль и название компании. Так появляются организация и её администратор (`admin`).
> - Есть вход по email и паролю. Пароль хранится только хэшем argon2id. Токен доступа — короткоживущий JWT на Ed25519 (EdDSA), другие сервисы проверяют его сами. Токен обновления — одноразовый, лежит в httpOnly cookie и меняется при каждом обновлении. Есть выход.
> - Письма отправляются через порт `Mailer`. В разработке их перехватывает Mailpit в compose, в проде — любой SMTP.
> - Первый супервизор создаётся при старте identity из `.env`, если супервизора ещё нет.
> - Регистрация и вход защищены от перебора: лимит запросов по email и по IP. На неверный пароль и на неизвестный email отказ одинаковый.
> - **Не входит.** Права, `Actor` и проверка токена в `api`, добавление и блокировка пользователей — это спека 024. Экраны входа и регистрации — 014. Восстановление пароля — D-112.
> - **Что нужно от человека.** Ответить на вопросы Q-1…Q-12 в разделе 9. В каждом есть рекомендация, её можно принять целиком.

## 1. Контекст и цель

Роадмап, [раздел 8 «Пользователи, доступ и баланс»](../../AI_PLATFORM_ROADMAP.md#8-пользователи-доступ-и-баланс), и этап 5.

Сейчас на платформе нет пользователей. `api` принимает любой запрос, а кабинет работает за одного пользователя (этап 1). Для критерия 13 роадмапа и сценария S-1 компания должна зарегистрироваться сама: «email → письмо → пароль → кабинет».

После спеки сервис identity регистрирует компанию и подтверждает email письмом. Он создаёт организацию с администратором, пускает по паролю и выдаёт токены. Подписанный токен доступа содержит пользователя, организацию и роль. Позже спека 024 научит `api` и остальные сервисы проверять этот токен и права, а спека 014 добавит экраны.

## 2. Объём

**Входит:**
- Ядро `packages/identity-core` и его порты: хранилище, хэшер паролей, подпись токенов, непрозрачные токены, почта, ограничитель частоты, часы, id и лог.
- Сервис `apps/identity` на Fastify: эндпоинты 4.4 и `GET /health`.
- Схемы запросов и ответов, роли и утверждения токена — в `@swag/contracts` (`auth.ts`).
- Конфиг `IdentityConfig` в `@swag/config`. Переменные — в `.env.example` и локальном `.env`.
- Миграция `0003_identity.sql` и хранилище `createPostgresIdentityStore` в `@swag/adapter-postgres`.
- Хранилище, почта и ограничитель частоты в памяти — в `@swag/adapter-memory`.
- Новые адаптеры:
  - `@swag/adapter-crypto`: argon2id на `@node-rs/argon2` и непрозрачные токены на `node:crypto`;
  - `@swag/adapter-jose`: подпись и проверка JWT на `jose`;
  - `@swag/adapter-smtp`: SMTP на `nodemailer`.
- В compose: сервисы `identity` и `mailpit`. Скрипт `npm run identity:keys` выпускает ключ подписи для `.env`.
- Первый супервизор из `.env` (Q-3).
- Тест `[stack]` по шагам 2–6 и 10 сценария S-1 на уровне HTTP (из S-1).

**Не входит** (агент это не делает, даже если кажется логичным):
- Тип `Actor`, список прав `Permission`, соответствие роли и прав. Проверка токена и доступа по организации в `api`, оркестраторе и gateway. Всё это — спека 024. Адаптер проверки токена `@swag/adapter-jose` появляется здесь, но подключает его к сервисам 024.
- Добавление пользователей администратором, смена роли, блокировка и отзыв токенов заблокированного — 024.
- Экраны регистрации, подтверждения, входа и выхода, прокси `/auth` в UI, хранение токена доступа в UI — 014.
- Восстановление и смена пароля — D-112.
- Смена email, удаление аккаунта и организации, приглашение по ссылке.
- Вход через Google или OIDC — после MVP (роадмап, раздел 8).
- Ротация ключа подписи, JWKS-эндпоинт, несколько активных ключей. Сейчас ключ один с `kid`, ротация — после MVP.
- Выбор SMTP-провайдера для прода. Адаптер работает с любым SMTP по `SMTP_URL`.
- Баланс, пополнение и видимость данных организации администратору (остаток D-10) — 013 и 024.
- Проверка пароля по базам утечек, CAPTCHA, двухфакторный вход.
- События платформы (`PlatformEvent`) об identity — шина и лента их не получают.

## 3. Требования

| ID | Требование | Приоритет |
|---|---|---|
| REQ-012-1 | Сервис identity MUST быть отдельной оболочкой `apps/identity`. Вся логика регистрации, входа и токенов MUST лежать в `identity-core`, всё внешнее — через порты 4.3. | MUST |
| REQ-012-2 | `POST /auth/registrations` MUST принимать email. Email нормализуется: `trim` и нижний регистр. Сервис отправляет на него письмо 4.6 со ссылкой подтверждения и отвечает `202` с пустым телом. | MUST |
| REQ-012-3 | Ответ на регистрацию MUST быть одинаковым для нового email и для email существующего пользователя: тот же код и то же тело. Для существующего — письмо «аккаунт уже есть» без ссылки подтверждения, новая подтверждающая запись не создаётся (Q-9). | MUST |
| REQ-012-4 | Ссылка подтверждения MUST нести одноразовый случайный токен (32 байта, base64url). В хранилище лежит только его SHA-256. Срок жизни — `IDENTITY_CONFIRM_TTL_S` (Q-4). | MUST |
| REQ-012-5 | `POST /auth/registrations/confirm` MUST в одной транзакции погасить токен подтверждения и создать организацию с названием из запроса и пользователя с ролью `admin` в ней. Затем сервис выдаёт токены, как при входе. | MUST |
| REQ-012-6 | Погашенный, просроченный и неизвестный токен подтверждения MUST давать один и тот же отказ `400 invalid_token`. Из двух одновременных подтверждений одним токеном MUST пройти ровно одно. | MUST |
| REQ-012-7 | Если на email уже есть пользователь, подтверждение MUST отвечать `409 email_taken` и не создавать организацию. Это случай двух регистраций, подтверждённых по очереди. | MUST |
| REQ-012-8 | Пароль MUST храниться только хэшем argon2id с параметрами 4.7. Пароль, его хэш и токены MUST NOT попадать в логи, ответы (кроме своих токенов клиенту), события и трейсы. | MUST |
| REQ-012-9 | `POST /auth/login` MUST при верном email и пароле выдавать токен доступа и токен обновления. На неверный пароль и на неизвестный email ответ MUST быть одинаковым (`401 invalid_credentials`), и хэшер вызывается ровно один раз в обоих случаях. | MUST |
| REQ-012-10 | Токен доступа MUST быть JWT с `alg: EdDSA` (Ed25519) и `kid` в заголовке. Утверждения — `AccessTokenClaims` 4.1, срок — `IDENTITY_ACCESS_TTL_S` (Q-1). | MUST |
| REQ-012-11 | Токен обновления MUST быть непрозрачным случайным токеном сессии, в хранилище — только его SHA-256. Его передаёт cookie 4.5. Каждое `POST /auth/refresh` меняет токен. Повтор уже заменённого токена MUST отзывать всю сессию (Q-1). | MUST |
| REQ-012-12 | `POST /auth/logout` MUST отзывать сессию токена обновления из cookie и стирать cookie. Отозванный и просроченный токен обновления MUST давать `401 invalid_refresh_token`. | MUST |
| REQ-012-13 | `GET /auth/me` MUST проверять токен доступа из `Authorization: Bearer` адаптером проверки 4.3 и отдавать пользователя и организацию. Нет токена, неверная подпись, чужой ключ, просроченный токен, другой `alg`, `iss` или `aud` — `401 unauthorized`. | MUST |
| REQ-012-14 | Адаптер `createJoseVerifier` MUST проверять токен по открытому ключу, без запроса в identity: подпись, `alg`, `kid`, `iss`, `aud`, `exp`. Наружу он отдаёт разобранные `AccessTokenClaims` или отказ. | MUST |
| REQ-012-15 | При старте identity MUST создавать супервизора из `IDENTITY_SUPERVISOR_EMAIL` и `IDENTITY_SUPERVISOR_PASSWORD`, если обе переменные заданы и пользователя с ролью `supervisor` нет. Если email занят пользователем другой роли, старт MUST падать с логом `error` (Q-3). | MUST |
| REQ-012-16 | Регистрация и вход MUST ограничиваться по частоте ключами 4.8. Сверх лимита — `429 rate_limited`, письмо не отправляется, хэшер не вызывается. | MUST |
| REQ-012-17 | Ограничитель в памяти MUST удалять записи истёкших окон: размер его `Map` не растёт без предела. | MUST |
| REQ-012-18 | Ошибка отправки письма MUST давать `503 mail_unavailable` и лог `error` `mail_send_failed` без адреса. Ответ одинаковый для нового и существующего email. | MUST |
| REQ-012-19 | Пароль MUST быть длиной от 10 до 128 символов, без правил состава (Q-10). Название организации — от 1 до 200 символов после `trim`. | MUST |
| REQ-012-20 | Ответы с токенами MUST нести `Cache-Control: no-store`. Тело запроса больше `IDENTITY_BODY_LIMIT_BYTES` — `413`. | MUST |
| REQ-012-21 | Порты `identity` и `mailpit` MUST публиковаться только на `127.0.0.1`. | MUST |
| REQ-012-22 | События безопасности MUST логироваться уровнем `warn` без email, пароля и токенов. Это `login_failed`, `rate_limited`, `refresh_reuse_detected` и `confirm_invalid_token`, в контексте — `userId`, если он известен. | MUST |
| REQ-012-23 | identity SHOULD применять миграции при старте тем же `runMigrations`, что `api` и gateway. | SHOULD |

## 4. Контракты

### 4.1. `@swag/contracts`, файл `src/auth.ts`

Экспортируется из `src/index.ts` (`export * from './auth.ts'`).

```ts
import { z } from 'zod';

export const UserId = z.uuid();
export const OrgId = z.uuid();
export const Role = z.enum(['user', 'admin', 'supervisor']); // Q-8
export type Role = z.infer<typeof Role>;

export const Email = z.string().trim().toLowerCase().pipe(z.email().max(254));
export const Password = z.string().min(10).max(128); // Q-10; без trim
export const OrganizationName = z.string().trim().min(1).max(200);

export const RegistrationRequest = z.object({ email: Email });
export const RegistrationConfirmRequest = z.object({
  token: z.string().min(1).max(200),
  password: Password,
  organizationName: OrganizationName, // Q-5
});
export const LoginRequest = z.object({ email: Email, password: z.string().min(1).max(128) });

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

export const AuthUser = z.object({ id: UserId, email: z.string(), role: Role, orgId: OrgId.nullable() });
export const AuthOrganization = z.object({ id: OrgId, name: z.string() });

export const AuthSession = z.object({
  accessToken: z.string(),
  expiresIn: z.number().int(), // секунды, = IDENTITY_ACCESS_TTL_S
  user: AuthUser,
  organization: AuthOrganization.nullable(), // null у supervisor
});
export const AuthRefreshed = AuthSession.pick({ accessToken: true, expiresIn: true });
export const AuthMe = AuthSession.pick({ user: true, organization: true });

export const AuthErrorCode = z.enum([
  'validation_error', 'invalid_token', 'email_taken', 'invalid_credentials',
  'invalid_refresh_token', 'unauthorized', 'rate_limited', 'mail_unavailable', 'internal_error',
]);
```

Тело ошибки — как у `api`: `{ error: { code, message, issues? } }`.

### 4.2. Ядро `identity-core`: операции

`createIdentityCore(deps: IdentityCoreDeps): IdentityCore`. Операции не бросают: результат — `Result<T>` той же формы, что в `api-core` (`{ ok: true, value } | { ok: false, error: { code, message, issues? } }`), `code` — из `AuthErrorCode`. Исключение порта (хранилище, почта) превращается в `internal_error`, у почты — в `mail_unavailable`. Ошибка логируется и наружу не уходит.

```ts
export interface RequestMeta { ip: string } // ключ лимитов 4.8; оболочка берёт request.ip

export type IssuedSession = { session: AuthSession; refreshToken: string }; // refreshToken оболочка кладёт в cookie 4.5, в тело не попадает

export interface IdentityCore {
  info(): ServiceInfo;
  requestRegistration(body: unknown, meta: RequestMeta): Promise<Result<void>>;
  confirmRegistration(body: unknown, meta: RequestMeta): Promise<Result<IssuedSession>>;
  login(body: unknown, meta: RequestMeta): Promise<Result<IssuedSession>>;
  refresh(refreshToken: string | undefined): Promise<Result<{ refreshed: AuthRefreshed; refreshToken: string }>>;
  logout(refreshToken: string | undefined): Promise<Result<void>>; // нет или неизвестен — тоже ok
  me(accessToken: string | undefined): Promise<Result<AuthMe>>;
  ensureSupervisor(): Promise<void>; // бросает при занятом email (REQ-012-15); вызывает оболочка до listen
}
```

Алгоритмы. `now` — `clock.now()`, сроки — из `settings`.

- **requestRegistration**:
  1. Разобрать `RegistrationRequest`, ошибка — `validation_error`.
  2. Лимиты `register:ip:<ip>` и `register:email:<email>` (4.8). Сверх лимита — `rate_limited`.
  3. `store.findUserByEmail`. Пользователь есть — `mailer.send(alreadyRegisteredMail)`.
  4. Пользователя нет — `opaque.create()` и `store.addConfirmation({ tokenHash, email, expiresAt: now + confirmTtl })`, затем `mailer.send(confirmMail(link))`. Ссылка — `${confirmUrl}?token=${token}`.
  5. Ошибка `send` — `mail_unavailable`.
- **confirmRegistration**:
  1. Разобрать `RegistrationConfirmRequest`.
  2. Лимит `confirm:ip:<ip>`.
  3. `hasher.hash(password)`.
  4. `store.confirmRegistration({ tokenHash: opaque.hash(token), now, org: { id, name }, user: { id, passwordHash, role: 'admin', orgId, createdAt: now } })`. Email берётся из погашенной записи внутри транзакции.
  5. Ответы хранилища: `invalid_token` — лог `warn` `confirm_invalid_token`, ответ `invalid_token`; `email_taken` — ответ `email_taken`; `ok` — `issueSession(user, org)`.
- **login**:
  1. Разобрать `LoginRequest`.
  2. Лимиты `login:ip:<ip>` и `login:email:<email>`.
  3. `store.findUserByEmail`.
  4. Проверка пароля. Пользователь есть — `hasher.verify(user.passwordHash, password)`. Пользователя нет — `hasher.verify(dummyHash, password)`, где `dummyHash` вычисляется один раз при первом таком входе через `hasher.hash` от случайной строки `opaque.create().token`.
  5. Пароль не подошёл или пользователя нет — лог `warn` `login_failed` (`userId`, если есть) и ответ `invalid_credentials`.
  6. Иначе — `issueSession`.
- **issueSession** (внутренняя):
  1. `opaque.create()` даёт токен обновления.
  2. `store.createSession({ id, userId, refreshHash, expiresAt: now + refreshTtl, createdAt: now })`.
  3. `signer.sign(claims)`, где `iat = floor(now/1000)` и `exp = iat + accessTtl`.
  4. Вернуть `AuthSession` и `refreshToken`.
- **refresh**:
  1. Токена нет — `invalid_refresh_token`.
  2. `store.rotateSession({ oldHash: opaque.hash(token), newHash, now, expiresAt: now + refreshTtl })`.
  3. Ответ `ok` — подписать новый токен доступа по пользователю сессии.
  4. Ответ `reused` (токен равен `previous_hash` живой сессии) — хранилище отзывает сессию, лог `warn` `refresh_reuse_detected` (`userId`), ответ `invalid_refresh_token`.
  5. Ответ `invalid` (нет, отозвана, просрочена) — `invalid_refresh_token`.
- **logout**: `store.revokeSession(opaque.hash(token), now)`. Сессии нет — тоже `ok`.
- **me**:
  1. `verifier.verify(token)`. Отказ — `unauthorized`.
  2. `store.findUserById(sub)`. Пользователя нет — `unauthorized`.
  3. Вернуть пользователя и организацию.
- **ensureSupervisor**:
  1. `settings.supervisor` равен `null` — ничего не делать.
  2. `store.hasSupervisor()` вернул `true` — ничего не делать.
  3. `store.findUserByEmail(email)` нашёл пользователя другой роли — бросить `Error('supervisor email taken')`.
  4. Иначе — `store.createUser({ role: 'supervisor', orgId: null, passwordHash: hasher.hash(password) })` и лог `info` `supervisor_created` (`userId`).

### 4.3. Порты `identity-core`

```ts
export interface Clock { now(): number } // мс эпохи
export interface IdGenerator { uuid(): string }
export interface Logger { debug; info; warn; error } // форма — как в api-core, LogContext без email и секретов

export type StoredUser = { id: string; email: string; passwordHash: string; role: Role; orgId: string | null; createdAt: number };
export type StoredOrganization = { id: string; name: string; createdAt: number };

export interface IdentityStore {
  findUserByEmail(email: string): Promise<StoredUser | null>;
  findUserById(id: string): Promise<{ user: StoredUser; organization: StoredOrganization | null } | null>;
  hasSupervisor(): Promise<boolean>;
  createUser(user: StoredUser): Promise<void>; // нарушение уникальности email — reject
  addConfirmation(c: { tokenHash: string; email: string; expiresAt: number; createdAt: number }): Promise<void>;
  confirmRegistration(input: {
    tokenHash: string; now: number;
    org: StoredOrganization; user: Omit<StoredUser, 'email'>;
  }): Promise<{ status: 'ok'; email: string } | { status: 'invalid_token' } | { status: 'email_taken' }>;
  createSession(s: { id: string; userId: string; refreshHash: string; expiresAt: number; createdAt: number }): Promise<void>;
  rotateSession(input: { oldHash: string; newHash: string; now: number; expiresAt: number }):
    Promise<{ status: 'ok'; userId: string } | { status: 'reused'; userId: string } | { status: 'invalid' }>;
  revokeSession(refreshHash: string, now: number): Promise<void>;
}

export interface PasswordHasher {
  hash(password: string): Promise<string>;              // PHC-строка argon2id
  verify(hash: string, password: string): Promise<boolean>; // false и на битую строку хэша
}

export interface OpaqueTokens {
  create(): { token: string; hash: string }; // 32 байта случайности base64url (43 символа); hash = SHA-256 hex
  hash(token: string): string;
}

export interface TokenSigner { sign(claims: AccessTokenClaims): Promise<string> }
export interface TokenVerifier { verify(token: string): Promise<AccessTokenClaims | null> } // null — любой отказ

export type MailMessage = { to: string; subject: string; text: string };
export interface Mailer { send(message: MailMessage): Promise<void> } // reject — не отправлено

export interface RateLimiter {
  hit(key: string, limit: number, windowMs: number): Promise<boolean>; // true — разрешено, попытка засчитана
}

export interface IdentityCoreDeps {
  version: string;
  store: IdentityStore; hasher: PasswordHasher; opaque: OpaqueTokens;
  signer: TokenSigner; verifier: TokenVerifier; mailer: Mailer; limiter: RateLimiter;
  clock: Clock; ids: IdGenerator; log: Logger;
  settings: {
    confirmUrl: string; // IDENTITY_CONFIRM_URL
    accessTtlS: number; refreshTtlS: number; confirmTtlS: number;
    supervisor: { email: string; password: string } | null;
  };
}
```

Правила `confirmRegistration` и `rotateSession` в хранилище. Обе операции атомарны, в Postgres каждая — одна транзакция.
- **`confirmRegistration`**:
  1. `update email_confirmations set used_at = now where token_hash = $1 and used_at is null and expires_at > now returning email`. Ни одной строки — `invalid_token`.
  2. Есть пользователь с этим email — `rollback`, затем `email_taken`. Токен при этом не гасится.
  3. Иначе вставить организацию и пользователя, `commit`, вернуть `ok`.
  4. Гонку двух подтверждений на один email закрывает уникальный индекс `users.email`. Нарушение — `rollback`, затем `email_taken`.
- **`rotateSession`**:
  1. Найти сессию с `refresh_hash = oldHash`, где `revoked_at is null` и `expires_at > now`, с блокировкой `for update`.
  2. Нашлась — `previous_hash = refresh_hash`, `refresh_hash = newHash`, `expires_at = $expiresAt`, вернуть `ok`.
  3. Не нашлась, но есть живая сессия с `previous_hash = oldHash` — `revoked_at = now`, вернуть `reused`.
  4. Иначе — `invalid`.

### 4.4. HTTP `apps/identity`

Префикс `/auth`, JSON, порт `IDENTITY_PORT`. Сервис стоит за прокси UI на том же origin, поэтому CORS не включается.

| Метод и путь | Тело | Успех | Ошибки |
|---|---|---|---|
| `POST /auth/registrations` | `RegistrationRequest` | `202`, тело пустое | `400 validation_error`, `413`, `429 rate_limited`, `503 mail_unavailable` |
| `POST /auth/registrations/confirm` | `RegistrationConfirmRequest` | `201 AuthSession` + cookie 4.5 | `400 validation_error`, `400 invalid_token`, `409 email_taken`, `429` |
| `POST /auth/login` | `LoginRequest` | `200 AuthSession` + cookie | `400`, `401 invalid_credentials`, `429` |
| `POST /auth/refresh` | — (cookie) | `200 AuthRefreshed` + новая cookie | `401 invalid_refresh_token` (cookie стирается) |
| `POST /auth/logout` | — (cookie) | `204`, cookie стирается | — |
| `GET /auth/me` | — (`Authorization: Bearer <jwt>`) | `200 AuthMe` | `401 unauthorized` |
| `GET /health` | — | `200 { status: 'ok', ...ServiceInfo }` | — |

Ответы `201` и `200` с `accessToken` несут `Cache-Control: no-store`. Лог запросов Fastify не пишет тело и заголовки `authorization` и `cookie`.

### 4.5. Cookie токена обновления

`swag_refresh=<token>`, атрибуты `HttpOnly; SameSite=Strict; Path=/auth; Max-Age=<IDENTITY_REFRESH_TTL_S>`. `Secure` ставится, когда `IDENTITY_COOKIE_SECURE=true`. Стирание — та же cookie с `Max-Age=0`. Библиотека — `@fastify/cookie`, без подписи cookie: токен сам непрозрачный и случайный.

### 4.6. Письма

Отправитель — `MAIL_FROM`, текст plain, без HTML. Текст письма — константы `identity-core`.

- Подтверждение. Тема `Подтвердите регистрацию в Swag`. Текст: `Чтобы закончить регистрацию компании, откройте ссылку: <link>\nСсылка действует <N> ч. Если вы не регистрировались, ничего не делайте.`
- Аккаунт уже есть. Тема `Вы уже зарегистрированы в Swag`. Текст: `На этот адрес уже есть аккаунт. Войдите по своему паролю. Если это были не вы, ничего не делайте.`

### 4.7. Адаптеры

- **`@swag/adapter-crypto`**:
  - `createArgon2Hasher()` — `@node-rs/argon2`, алгоритм `Argon2id`, `memoryCost: 19456`, `timeCost: 2`, `parallelism: 1` (минимум OWASP Password Storage Cheat Sheet). Хэш начинается с `$argon2id$v=19$m=19456,t=2,p=1$`.
  - `createNodeOpaqueTokens()` — `randomBytes(32).toString('base64url')` и `createHash('sha256').update(token).digest('hex')`.
- **`@swag/adapter-jose`**:
  - `createJoseSigner({ privateKeyPem, kid })` — `SignJWT`, заголовок `{ alg: 'EdDSA', kid, typ: 'JWT' }`.
  - `createJoseVerifier({ publicKeyPem, kid })` — `jwtVerify` с `algorithms: ['EdDSA']`, `issuer: 'swag-identity'`, `audience: 'swag'`. Чужой `kid` — отказ. Утверждения после проверки разбираются `AccessTokenClaims`, ошибка разбора — тоже отказ.
  - `publicKeyFromPrivate(privateKeyPem)` — SPKI PEM для verifier самой identity.
- **`@swag/adapter-smtp`**: `createSmtpMailer({ url, from, timeoutMs })` на `nodemailer.createTransport(url)`. `connectionTimeout`, `greetingTimeout` и `socketTimeout` равны `timeoutMs`.
- **`@swag/adapter-memory`**:
  - `createMemoryIdentityStore()` — правила 4.3, атомарность на одном потоке JS.
  - `createMemoryMailer()` — поле `sent: MailMessage[]`, флаг `fail` для теста `mail_unavailable`.
  - `createMemoryRateLimiter({ now })` — фиксированное окно: запись `{ count, resetAt }` по ключу. Запись истёкшего окна заменяется при следующем `hit` по ключу. Когда `size > 10000`, при `hit` удаляются все истёкшие записи.
- **`@swag/adapter-postgres`**: `createPostgresIdentityStore(pool)` по 4.3 и таблицам 4.9.

Версии точные, на 2026-10-31 — последние, вышедшие не позже чем за две недели (Q-11):

| Пакет | Версия |
|---|---|
| `jose` | `6.2.12` |
| `@node-rs/argon2` | `2.2.2` |
| `nodemailer` | `10.1.2` |
| `@types/nodemailer` | `8.0.2` |
| `@fastify/cookie` | `11.1.3` |
| образ `axllent/mailpit` | `v1.31.6` |

### 4.8. Лимиты частоты

Это константы `identity-core`, числа — Q-6.

| Ключ | Лимит | Окно |
|---|---|---|
| `register:email:<email>` | 3 | 1 ч |
| `register:ip:<ip>` | 10 | 1 ч |
| `confirm:ip:<ip>` | 20 | 1 ч |
| `login:email:<email>` | 10 | 15 мин |
| `login:ip:<ip>` | 30 | 15 мин |

Засчитывается каждая попытка, не только неудачная. Ключи по email проверяются после ключей по IP, поэтому одна попытка расходует оба лимита. В MVP identity работает одним экземпляром, и счётчики в памяти обнуляются при перезапуске. Это допустимо (Q-6).

### 4.9. Миграция `packages/adapter-postgres/migrations/0003_identity.sql`

```sql
-- Up Migration
create table organizations (
  id uuid primary key,
  name text not null check (length(name) between 1 and 200),
  created_at timestamptz not null
);
create table users (
  id uuid primary key,
  email text not null unique,
  password_hash text not null,
  role text not null check (role in ('user', 'admin', 'supervisor')),
  org_id uuid references organizations (id),
  created_at timestamptz not null,
  check ((role = 'supervisor') = (org_id is null))
);
create table email_confirmations (
  token_hash text primary key,
  email text not null,
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null
);
create table sessions (
  id uuid primary key,
  user_id uuid not null references users (id),
  refresh_hash text not null unique,
  previous_hash text,
  expires_at timestamptz not null,
  revoked_at timestamptz,
  created_at timestamptz not null
);
create index sessions_previous_hash on sessions (previous_hash);

-- Down Migration
drop table sessions;
drop table email_confirmations;
drop table users;
drop table organizations;
```

Уборка просроченных записей `email_confirmations` и `sessions` в 012 не делается. Строк мало — по одной на регистрацию и на вход. Уборку стоит добавить вместе с блокировкой в 024 (N-20).

### 4.10. Конфиг `IdentityConfig` (`@swag/config`)

```ts
export const IdentityConfig = z.object({
  DATABASE_URL: z.string().url(),
  OTEL_EXPORTER_OTLP_ENDPOINT: OptionalUrl,          // как у LlmGatewayConfig: без BaseConfig, NATS identity не нужен
  LOG_LEVEL: LogLevel.default('info'),
  TELEMETRY_FLUSH_TIMEOUT_MS: FlushTimeoutMs,
  IDENTITY_PORT: Port,
  IDENTITY_CONFIRM_URL: z.string().url(),            // страница UI (014); в dev http://127.0.0.1:4200/auth/confirm
  IDENTITY_JWT_PRIVATE_KEY: z.string().min(1),       // PKCS8 PEM Ed25519 в base64 одной строкой (Q-2)
  IDENTITY_JWT_KID: z.string().min(1),
  IDENTITY_ACCESS_TTL_S: z.coerce.number().int().min(60).default(900),
  IDENTITY_REFRESH_TTL_S: z.coerce.number().int().min(3600).default(2592000),
  IDENTITY_CONFIRM_TTL_S: z.coerce.number().int().min(600).default(86400),
  IDENTITY_COOKIE_SECURE: z.enum(['true', 'false']).transform((v) => v === 'true'),
  IDENTITY_BODY_LIMIT_BYTES: z.coerce.number().int().min(1024).default(16384),
  IDENTITY_SUPERVISOR_EMAIL: Email.optional(),       // вместе с паролем или обе пустые (refine)
  IDENTITY_SUPERVISOR_PASSWORD: Password.optional(),
  SMTP_URL: z.string().url(),                        // dev: smtp://mailpit:1025
  SMTP_TIMEOUT_MS: z.coerce.number().int().min(1).default(10000),
  MAIL_FROM: z.string().min(3),                      // dev: Swag <no-reply@swag.local>
}).refine((c) => (c.IDENTITY_SUPERVISOR_EMAIL === undefined) === (c.IDENTITY_SUPERVISOR_PASSWORD === undefined));
```

Пустая строка в `IDENTITY_SUPERVISOR_*` читается как `undefined` — preprocess по образцу `OptionalUrl`. Задан ровно один из двух `IDENTITY_SUPERVISOR_*` — ошибка конфига.

### 4.11. Compose и скрипты

- Сервис `identity`:
  - образ из `apps/identity/Dockerfile` по образцу `apps/api`;
  - `environment` — только переменные `IdentityConfig`;
  - порт `127.0.0.1:${IDENTITY_PORT}:${IDENTITY_PORT}`;
  - `depends_on`: `postgres` (healthy), `mailpit` (started), `otel-collector` (started);
  - healthcheck — `GET /health`.
- Сервис `mailpit`: образ `axllent/mailpit:v1.31.6`, порты `127.0.0.1:1025:1025` (SMTP) и `127.0.0.1:${MAILPIT_UI_PORT}:8025` (UI и API писем), без volume — письма живут до перезапуска.
- `.env.example` и `.env`: `IDENTITY_PORT=3003`, `MAILPIT_UI_PORT=8025`, остальные переменные 4.10 с dev-значениями. `IDENTITY_JWT_PRIVATE_KEY` в `.env.example` пустая, в `.env` её заполняет скрипт.
- `npm run identity:keys` (`scripts/identity-keys.ts`):
  - печатает `IDENTITY_JWT_PRIVATE_KEY=<base64 PKCS8>` и `IDENTITY_JWT_PUBLIC_KEY=<base64 SPKI>` для нового ключа Ed25519 (`generateKeyPairSync('ed25519')`);
  - с флагом `--write-env` дописывает или заменяет `IDENTITY_JWT_PRIVATE_KEY` в `.env` и в консоль ключ не печатает.

  `IDENTITY_JWT_PUBLIC_KEY` в 012 никто не читает: он нужен 024.
- Тесты `[stack]` запускаются, только если заданы `STACK_TEST_IDENTITY_URL` и `STACK_TEST_MAILPIT_URL` (по образцу D-102 (а)). Письма читаются через API Mailpit:
  - `GET /api/v1/search?query=to:"<email>"` — `messages[].ID`;
  - `GET /api/v1/message/{ID}` — поле `Text`.

## 5. Критерии приёмки

- **AC-012-1** — *Given* схемы 4.1 *When* разбирается `RegistrationRequest` с email `"  Shop@Example.COM "`, пароль из 9 и из 129 символов, название из пробелов *Then* email становится `shop@example.com`, пароли и название отклоняются, пароль из 10 символов принимается.
- **AC-012-2** — *Given* значения `.env.example` и ключ из `identity:keys` *When* `loadConfig(IdentityConfig)` *Then* конфиг разобран. Без `IDENTITY_JWT_PRIVATE_KEY` — ошибка. Задан только `IDENTITY_SUPERVISOR_EMAIL` — ошибка.
- **AC-012-3** — *Given* пустая схема *When* `runMigrations` *Then*:
  - таблицы 4.9 существуют;
  - вставка `supervisor` с `org_id`, `admin` без `org_id` и второго пользователя с тем же email отклоняется ограничениями;
  - повторный запуск ничего не меняет.
- **AC-012-4** — *Given* ядро с хранилищем и почтой в памяти *When* `requestRegistration` с новым email *Then*:
  - результат `ok`;
  - отправлено одно письмо на этот email с темой 4.6 и ссылкой `${confirmUrl}?token=<43 символа base64url>`;
  - в хранилище подтверждений лежит запись с `hash(token)` и `expiresAt = now + confirmTtl`, сырого токена в хранилище нет.
- **AC-012-5** — *Given* существующий пользователь *When* `POST /auth/registrations` с его email и с новым email *Then* оба ответа — `202` с одинаковым телом. Существующему пришло письмо «аккаунт уже есть» без `token=`, новых записей подтверждения для него нет (S-1, шаг 4).
- **AC-012-6** — *Given* токен подтверждения *When* `POST /auth/registrations/confirm` с паролем и названием *Then*:
  - ответ `201 AuthSession`, `user.role = admin`, `organization.name` — из запроса, `user.orgId = organization.id`;
  - стоит cookie `swag_refresh`;
  - `accessToken` проверяется `createJoseVerifier` с утверждениями пользователя;
  - в хранилище `passwordHash ≠ password`, и `hasher.verify(passwordHash, password)` возвращает `true`. (S-1, шаги 2–3)
- **AC-012-7** — *Given* подтверждение прошло *When* тот же токен подтверждается второй раз *Then* `400 invalid_token`, организация одна (S-1, шаг 4).
- **AC-012-8** — *Given* токен с истёкшим сроком (часы сдвинуты на `confirmTtl + 1 с`) и неизвестный токен *When* подтверждение *Then* оба ответа — `400 invalid_token` с одинаковым телом, в логе `warn` `confirm_invalid_token`.
- **AC-012-9** — *Given* Postgres и один токен подтверждения *When* два `confirmRegistration` параллельно *Then* ровно один `ok`, второй — `invalid_token`, в `organizations` одна строка.
- **AC-012-10** — *Given* две регистрации одного email, обе с письмами *When* подтверждается первая, затем вторая *Then* вторая — `409 email_taken`, организация одна, токен второй регистрации не погашен.
- **AC-012-11** — *Given* зарегистрированный администратор *When* `POST /auth/login` с верным паролем *Then*:
  - `200 AuthSession` и cookie;
  - в утверждениях `sub`, `org`, `role` — пользователя, `iss = swag-identity`, `aud = swag`, `exp - iat = accessTtl`;
  - в заголовке JWT `alg = EdDSA` и `kid = IDENTITY_JWT_KID`. (S-1, шаг 5)
- **AC-012-12** — *Given* хэшер-шпион *When* вход с неверным паролем существующего email и вход с неизвестным email *Then* оба ответа — `401 invalid_credentials` с одинаковым телом, `verify` вызван ровно один раз в каждом случае, в логе два `warn` `login_failed` без email (S-1, шаг 5).
- **AC-012-13** — *Given* часы в памяти *When*:
  - 4 регистрации одного email за час;
  - 11 регистраций с одного IP на разные email;
  - 11 входов одного email за 15 мин;
  - сдвиг часов на длину окна и ещё одна попытка.

  *Then* 4-я, 11-я и 11-я попытки — `429 rate_limited`, письмо не отправлено, хэшер не вызван, в логе `warn` `rate_limited`; после сдвига — снова разрешено.
- **AC-012-14** — *Given* `createMemoryRateLimiter` *When* 20 000 разных ключей с окном 1 с, затем сдвиг часов на 2 с и один `hit` *Then* размер внутреннего `Map` не больше 1.
- **AC-012-15** — *Given* сессия после входа *When* `POST /auth/refresh` с cookie *Then* `200 AuthRefreshed` и новая cookie с другим токеном. Повтор старого токена — `401 invalid_refresh_token`, лог `warn` `refresh_reuse_detected`, после этого и новый токен даёт `401`.
- **AC-012-16** — *Given* сессия *When* `POST /auth/logout` *Then* `204`, cookie стёрта (`Max-Age=0`), `POST /auth/refresh` с прежним токеном — `401`. Сессия с истёкшим сроком (часы сдвинуты на `refreshTtl + 1 с`) — тоже `401`.
- **AC-012-17** — *Given* `IDENTITY_COOKIE_SECURE=false` и `true` *When* вход *Then* cookie несёт `HttpOnly`, `SameSite=Strict`, `Path=/auth`, `Max-Age=refreshTtl`, а `Secure` — только при `true`. Ответ входа и подтверждения несёт `Cache-Control: no-store`.
- **AC-012-18** — *Given* `GET /auth/me` *When* токен верный *Then* `200 AuthMe` своего пользователя. *When* токена нет, подпись испорчена, токен подписан другим ключом, просрочен, с `alg: none`, с другим `aud` или `iss` *Then* каждый случай — `401 unauthorized`.
- **AC-012-19** — *Given* `createJoseSigner` и `createJoseVerifier` на одной паре ключей *When* проверяются:
  - свой токен;
  - токен с чужим `kid`;
  - токен с изменённым утверждением;
  - токен с утверждениями, не проходящими `AccessTokenClaims` (`role: 'root'`).

  *Then* свой — утверждения, остальные — `null`.
- **AC-012-20** — *Given* `settings.supervisor` задан и супервизора нет *When* `ensureSupervisor` *Then* создан пользователь `supervisor` с `orgId = null`, лог `info` `supervisor_created`. Повторный вызов ничего не меняет. При `supervisor = null` ничего не создаётся. Email занят администратором — вызов бросает, оболочка завершает процесс с кодом 1 и логом `error`.
- **AC-012-21** — *Given* созданный супервизор *When* вход по его email и паролю *Then* `200`, `org = null` в утверждениях, `organization = null` в теле (S-1, шаг 10 — вход; «видит обе организации» — 024).
- **AC-012-22** — *Given* полный сценарий «регистрация → подтверждение → вход → обновление → выход → неверный вход» в оболочке с телеметрией в памяти *When* просматриваются все записи логов и спанов *Then* в них нет:
  - email;
  - пароля;
  - его хэша;
  - сырого токена подтверждения;
  - токена обновления;
  - токена доступа.
- **AC-012-23** — *Given* `createArgon2Hasher` *When* `hash` одного пароля дважды и `verify` *Then* хэши разные, оба начинаются с `$argon2id$v=19$m=19456,t=2,p=1$`. `verify` верного пароля — `true`, неверного и битой строки хэша — `false` без исключения.
- **AC-012-24** — *Given* `createNodeOpaqueTokens` *When* 1000 вызовов `create` *Then* токены уникальны, длиной 43 и из алфавита base64url, `hash` — 64 hex-символа и равен `hash(token)`.
- **AC-012-25** — *Given* почта, которая падает *When* `POST /auth/registrations` с новым и с существующим email *Then* оба — `503 mail_unavailable` с одинаковым телом, в логе `error` `mail_send_failed` без адреса.
- **AC-012-26** — *Given* тело больше `IDENTITY_BODY_LIMIT_BYTES`, не-JSON и JSON без нужных полей *When* `POST /auth/login` *Then* `413`, `400 validation_error`, `400 validation_error`.
- **AC-012-27** `[stack]` — *Given* поднятый контур с `identity` и `mailpit` *When* регистрация email, письмо из API Mailpit, подтверждение по токену из ссылки, выход, вход, повторное подтверждение, вход супервизора из `.env` *Then* каждый шаг даёт ответ из AC-012-5…AC-012-21 (из S-1, шаги 2–6 и 10, на уровне HTTP).
- **AC-012-28** — *Given* `adapter-smtp` и Mailpit из compose *When* `send` *Then* письмо найдено через API Mailpit с темой, отправителем `MAIL_FROM` и текстом. Без `STACK_TEST_MAILPIT_URL` тест пропускается.
- **AC-012-29** `[manual]` — *Given* `npm run identity:keys -- --write-env` и `npm run up` *When* `docker compose ps` и `curl` по шагам AC-012-27 *Then*:
  - `identity` и `mailpit` healthy и started, их порты опубликованы только на `127.0.0.1`;
  - письмо видно в UI Mailpit на `http://127.0.0.1:8025`;
  - в `docker compose logs identity` нет email и токенов.

  Проверка — команды и вывод в журнал.
- **AC-012-30** — *Given* `createPostgresIdentityStore` *When* прогоняются те же сценарии хранилища, что для адаптера в памяти (общий набор тестов на два адаптера) *Then* результаты совпадают: `confirmRegistration`, `rotateSession` с `ok`, `reused` и `invalid`, `revokeSession`, `hasSupervisor`.
- **AC-012-31** `[manual]` — *Given* пакет `identity-core` *When* `npm run arch:check` *Then* проверка зелёная, в `dependencies` только `zod` и `@swag/contracts`, в коде нет `node:*`, `jose`, `@node-rs/argon2`, `nodemailer`. Проверка — вывод команды в журнал.

## 6. Нефункциональные требования

| ID | Требование | Как измеряется |
|---|---|---|
| NFR-012-1 | Один `verify` argon2id с параметрами 4.7 занимает от 20 до 500 мс на машине разработки. Если быстрее — параметры не понижаются, если медленнее — вопрос `D-n`. | замер p50 и p95 по 50 вызовам в `adapter-crypto/test/bench.test.ts` под `IDENTITY_BENCH=1`, цифры — в журнал |
| NFR-012-2 | p95 `POST /auth/login` меньше 600 мс на поднятом контуре при последовательных запросах | 100 входов в `[stack]` под `IDENTITY_BENCH=1`, цифры — в журнал |

## 7. Безопасность: что не должно сломаться

- Пароль хранится только хэшем argon2id → AC-012-6, AC-012-23 (S-1, шаг 6).
- Ни пароль, ни токены, ни email не попадают в логи и спаны → AC-012-22, AC-012-29.
- В базе нет сырых токенов подтверждения и обновления, только SHA-256 → AC-012-4, AC-012-30.
- По ответам регистрации и входа нельзя узнать, есть ли email → AC-012-5, AC-012-12, AC-012-25.
- Перебор пароля и массовые регистрации ограничены → AC-012-13. Память ограничителя не растёт → AC-012-14.
- Ссылка подтверждения одноразовая и с ограниченным сроком, гонка подтверждений безопасна → AC-012-7, AC-012-8, AC-012-9.
- Украденный и повторно использованный токен обновления отзывает сессию → AC-012-15.
- Токен с чужой подписью, `alg: none`, другим `kid`, `aud`, `iss` и просроченный отклоняется → AC-012-18, AC-012-19.
- Токен обновления недоступен скриптам страницы и не уходит на чужой сайт → AC-012-17.
- Порты только на `127.0.0.1` → AC-012-29.
- Ключ подписи не попадает в git: в `.env.example` значение пустое → AC-012-2, ревью диффа.
- `identity-core` не зависит от Node, `jose`, `argon2` и `nodemailer` → `npm run arch:check`.

## 8. Задачи для агента

Задачи выполняются по порядку, после каждой — коммит. Ветки этапов — по [implement-spec](../../.claude/skills/implement-spec/SKILL.md#ветка-на-этап).

- [x] **T-1.** `packages/contracts/src/auth.ts` по 4.1, экспорт из `src/index.ts`, тесты схем в `packages/contracts/test/auth.test.ts`. Закрывает: REQ-012-19, AC-012-1. Готово, когда: тесты зелёные, README `contracts` дополнен.
- [x] **T-2.** `IdentityConfig` по 4.10 в `packages/config/src/index.ts` и тест в `packages/config/test`. Переменные 4.10 и 4.11 — в `.env.example` и в локальный `.env` с dev-значениями, `IDENTITY_JWT_PRIVATE_KEY` пока пустая. Закрывает: AC-012-2 (без ключа — до T-14). Готово, когда: тест на ошибки конфига зелёный.
- [x] **T-3.** Миграция `0003_identity.sql` по 4.9 и тест в `packages/adapter-postgres/test/migrations.test.ts`. Закрывает: AC-012-3. Готово, когда: тест под `POSTGRES_TEST_URL` зелёный.
- [ ] **T-4.** Пакет `packages/identity-core` по образцу `api-core`: `package.json` (зависимости `zod`, `@swag/contracts`), `tsconfig`, ссылка в корневом `tsconfig.json`, README. Порты и типы 4.2–4.3 и константы 4.6 и 4.8 без операций, `info()`. Закрывает: REQ-012-1, AC-012-31. Готово, когда: `npm run typecheck` и `arch:check` зелёные, вывод в журнале.
- [ ] **T-5.** `createMemoryIdentityStore`, `createMemoryMailer`, `createMemoryRateLimiter` в `packages/adapter-memory` по 4.7. Общий набор тестов хранилища — `packages/adapter-memory/test/identity-store.contract.ts`: функция, которая принимает фабрику хранилища; её же вызовет T-11. Тест ограничителя. Закрывает: REQ-012-17, AC-012-14, AC-012-30 (часть памяти). Готово, когда: тесты зелёные.
- [ ] **T-6.** `requestRegistration` в `identity-core` по 4.2 с лимитами регистрации. Тесты на адаптерах в памяти и фейковых хэшере, токенах и подписи. Закрывает: REQ-012-2, REQ-012-3, REQ-012-4, REQ-012-16 (регистрация), REQ-012-18, AC-012-4, AC-012-13 (регистрация), AC-012-25 (ядро). Готово, когда: тесты зелёные.
- [ ] **T-7.** `confirmRegistration` и внутренний `issueSession`. Закрывает: REQ-012-5, REQ-012-6, REQ-012-7, AC-012-7, AC-012-8, AC-012-10 (ядро). Готово, когда: тесты зелёные.
- [ ] **T-8.** `login` и `me`, `dummyHash`, лимиты входа. Закрывает: REQ-012-9, REQ-012-13 (ядро), REQ-012-16 (вход), REQ-012-22, AC-012-12, AC-012-13 (вход). Готово, когда: тесты зелёные.
- [ ] **T-9.** `refresh` и `logout`. Закрывает: REQ-012-11, REQ-012-12, AC-012-15, AC-012-16 (ядро). Готово, когда: тесты зелёные.
- [ ] **T-10.** `ensureSupervisor`. Закрывает: REQ-012-15, AC-012-20 (ядро). Готово, когда: тесты зелёные.
- [ ] **T-11.** `createPostgresIdentityStore` по 4.3 в `packages/adapter-postgres/src/index.ts`, общий набор тестов из T-5 и параллельное подтверждение. Закрывает: AC-012-9, AC-012-30. Готово, когда: тесты под `POSTGRES_TEST_URL` зелёные, README `adapter-postgres` дополнен.
- [ ] **T-12.** Пакет `packages/adapter-crypto`: `createArgon2Hasher`, `createNodeOpaqueTokens` по 4.7, тесты и замер NFR-012-1. Закрывает: REQ-012-8 (хэш), AC-012-23, AC-012-24, NFR-012-1. Готово, когда: тесты зелёные, цифры замера в журнале.
- [ ] **T-13.** Пакет `packages/adapter-jose`: `createJoseSigner`, `createJoseVerifier`, `publicKeyFromPrivate` по 4.7, тесты на ключах, созданных в тесте. Закрывает: REQ-012-10, REQ-012-14, AC-012-19. Готово, когда: тесты зелёные.
- [ ] **T-14.** `scripts/identity-keys.ts` и команда `npm run identity:keys` по 4.11, тест на формат вывода и на `--write-env` во временный файл. Ключ — в локальный `.env`. Закрывает: AC-012-2 (полностью). Готово, когда: тест зелёный, `.env` содержит ключ.
- [ ] **T-15.** Пакет `packages/adapter-smtp`: `createSmtpMailer` по 4.7, тест `[stack]` с Mailpit. Закрывает: AC-012-28. Готово, когда: тест пропускается без `STACK_TEST_MAILPIT_URL` и зелёный с ним.
- [ ] **T-16.** Оболочка `apps/identity` (`app.ts`, `main.ts`, `start.ts` по образцу `apps/api`):
  - эндпоинты 4.4 и cookie 4.5;
  - `ensureSupervisor` и `runMigrations` до `listen`;
  - лог запросов без тела, `authorization` и `cookie`;
  - HTTP-тесты через `app.inject` на адаптерах в памяти, адаптер-jose и телеметрии в памяти.

  Закрывает: REQ-012-12, REQ-012-13, REQ-012-20, REQ-012-22, REQ-012-23, AC-012-5, AC-012-6, AC-012-11, AC-012-16, AC-012-17, AC-012-18, AC-012-20 (оболочка), AC-012-21, AC-012-22, AC-012-25, AC-012-26. Готово, когда: тесты зелёные, README пакета написан.
- [ ] **T-17.** Сервисы `identity` и `mailpit` в `compose.yaml` по 4.11, `apps/identity/Dockerfile`, раздел про identity и Mailpit в корневом README, `identity` в `infra:check`, если там перечислены сервисы. Закрывает: REQ-012-21. Готово, когда: `npm run up` поднимает оба сервиса healthy.
- [ ] **T-18.** Тест `[stack]` `apps/identity/test/stack.test.ts` по AC-012-27, замер NFR-012-2, ручная проверка AC-012-29 с выводом в журнал. В `docs/spec/scenarios.md` у S-1 — отметка о покрытых шагах. Закрывает: AC-012-27, AC-012-29, NFR-012-2. Готово, когда: тест зелёный на поднятом контуре, журнал заполнен.
- [ ] **T-19.** Документация:
  - `docs/architecture.md` — пакеты `identity-core`, `adapter-crypto`, `adapter-jose`, `adapter-smtp`, сервис `identity`;
  - сверка глоссария с кодом;
  - README всех затронутых пакетов.

  Закрывает: правило 7 `CLAUDE.md`. Готово, когда: `npm run check` зелёный.

## 9. Открытые вопросы

Пока список не пуст, спека не может быть `ready`. Агент дописывает сюда вопросы при `blocked`.

- [x] **Q-1. Токены: формат, сроки, хранение токена обновления.** *(из D-6; Claude, 2026-10-31)*
  - **Формат:** а) JWT на EdDSA (Ed25519); б) PASETO v4.public.
  - **Сроки:** доступ 15 мин, обновление 30 дней.
  - **Обновление:** одноразовое — каждое обновление выдаёт новый токен. Повтор старого отзывает сессию.
  - **Где UI держит токены:** обновления — в httpOnly cookie `SameSite=Strict` на `Path=/auth`, доступа — в памяти страницы.

  **Рекомендация: всё как в 4.1, 4.4 и 4.5.** JWT читают готовые библиотеки любого сервиса, а `jose` без зависимостей работает и в Node, и в браузере. Cookie недоступна скриптам страницы (XSS) и не уходит на чужой сайт (CSRF). Обмен токена при каждом обновлении с отзывом при повторе — рекомендация OWASP для токенов обновления. Минус: две вкладки, которые обновили токен одновременно, выкинут пользователя. Каркас 014 должен обновлять токен из одной вкладки.

  Часть D-6 «открытая регистрация или по приглашению, нужно ли подтверждение email» решена человеком 2026-10-27 (D-29): регистрация открытая, с подтверждением.
  **Ответ (человек, 2026-10-31):** по рекомендации.
- [x] **Q-2. Ключ подписи: откуда берётся и как его получают другие сервисы.** *(из D-6; Claude, 2026-10-31)*
  - **Источник:** а) закрытый ключ в `IDENTITY_JWT_PRIVATE_KEY`, его выпускает `npm run identity:keys`; б) identity создаёт ключ при первом старте и хранит в Postgres; в) dev-ключ прямо в `.env.example`.
  - **Как получают другие сервисы:** открытый ключ в их env (`IDENTITY_JWT_PUBLIC_KEY`, 024) или эндпоинт JWKS.

  **Рекомендация: «а» и открытый ключ в env.** Закрытый ключ не лежит в git и в базе. Проверяющий сервис не ходит в identity даже при старте, как требует роадмап. В «в» рабочий ключ лежит в репозитории и может попасть в прод. JWKS нужен только для ротации, а она в «Не входит».
  **Ответ (человек, 2026-10-31):** по рекомендации.
- [x] **Q-3. Первый супервизор.** *(из D-7; Claude, 2026-10-31)*
  - а) `IDENTITY_SUPERVISOR_EMAIL` и `IDENTITY_SUPERVISOR_PASSWORD` в `.env` — при старте, если супервизора нет;
  - б) консольная команда `npm run identity:supervisor`;
  - в) первый зарегистрированный пользователь.

  **Рекомендация: «а».** Работает в compose без ручных шагов, и S-1 (шаг 10) проходит на чистом контуре. Пароль из `.env` после первого старта не перечитывается, смена пароля — D-112. Если email занят другой ролью, старт падает: молча повышать администратора до супервизора нельзя. «в» опасно в проде: первым может оказаться чужой.
  **Ответ (человек, 2026-10-31):** по рекомендации.
- [x] **Q-4. Подтверждение email: ссылка или код, срок жизни.** *(из D-29; Claude, 2026-10-31)*
  а) ссылка с одноразовым токеном, 24 ч; б) шестизначный код, 15 мин.
  **Рекомендация: «а».** Сценарий S-1 и критерий 13 говорят о переходе по ссылке. Длинный случайный токен не нужно защищать от перебора, а код из 6 цифр требует отдельного лимита попыток. Ссылка ведёт на страницу UI (014), страница отправляет токен методом `POST`, поэтому в логах identity адреса с токеном нет.
  **Ответ (человек, 2026-10-31):** по рекомендации.
- [x] **Q-5. Где вводится название компании.** *(из D-29; Claude, 2026-10-31)*
  а) на шаге пароля, после перехода по ссылке; б) в первой форме вместе с email; в) позже, в кабинете.
  **Рекомендация: «а».** Первая форма — один email, как в S-1. Организация создаётся одной транзакцией вместе с пользователем, когда email уже подтверждён. Неподтверждённые регистрации не оставляют организаций-пустышек.
  **Ответ (человек, 2026-10-31):** по рекомендации.
- [x] **Q-6. Лимиты частоты и где хранить счётчики.** *(из D-29; Claude, 2026-10-31)*
  Числа таблицы 4.8: регистрация — 3 в час на email и 10 в час на IP, подтверждение — 20 в час на IP, вход — 10 за 15 мин на email и 30 за 15 мин на IP. Счётчики хранятся в памяти identity и обнуляются при перезапуске.
  **Рекомендация: так.** Числа — порядок рекомендаций OWASP по защите входа. Счётчики в памяти верны, пока identity — один экземпляр. Перенос в Postgres или Redis — когда экземпляров станет больше, тот же порт `RateLimiter`. Нужны ли другие числа?
  **Ответ (человек, 2026-10-31):** по рекомендации.
- [x] **Q-7. Почта: перехватчик в разработке и провайдер в проде.** *(из D-29; Claude, 2026-10-31)*
  **Рекомендация.** В разработке — Mailpit (`axllent/mailpit:v1.31.6`): перехватывает SMTP, письма видны в UI на `127.0.0.1:8025`, и тесты читают их через API. В проде — тот же адаптер `nodemailer` с `SMTP_URL` любого провайдера, сам провайдер (Unisender Go, Postmark, Amazon SES…) выбирается при выходе в прод, отдельной правкой `.env`. Подтвердить или назвать провайдера сейчас.
  **Ответ (человек, 2026-10-31):** по рекомендации.
- [x] **Q-8. Модель организации в 012.** *(из D-10; Claude, 2026-10-31)*
  - пользователь всегда ровно в одной организации, личных аккаунтов нет — организация может быть из одного человека;
  - в нескольких организациях пользователь состоять не может;
  - у пользователя одна роль: `user`, `admin` или `supervisor`;
  - у супервизора организации нет;
  - имена ролей — `user`, `admin`, `supervisor`.

  **Рекомендация: так.** Одна модель для всех случаев, в токене одна роль `role` и одна организация `org`. Несколько организаций на пользователя — после MVP, через таблицу членства и выбор организации при входе. Остальная часть D-10 — чей баланс, кто пополняет, что видит администратор — остаётся в `questions.md` для 013 и 024.
  **Ответ (человек, 2026-10-31):** по рекомендации.
- [x] **Q-9. Повторная регистрация на существующий email.** *(Claude, 2026-10-31)*
  а) тот же `202` и письмо «аккаунт уже есть»; б) тот же `202` без письма; в) `409` с ошибкой.
  **Рекомендация: «а».** Ответ не выдаёт, есть ли email на платформе. Настоящий владелец узнаёт из письма, что ему нужно войти. «в» позволяет перебором собрать список клиентов платформы.
  **Ответ (человек, 2026-10-31):** по рекомендации.
- [x] **Q-10. Правила пароля.** *(Claude, 2026-10-31)*
  Длина от 10 до 128 символов, без требований к составу (цифры, регистр) и без проверки по базам утечек.
  **Рекомендация: так.** NIST SP 800-63B советует длину вместо правил состава. Минимум 10 — с запасом к рекомендованным 8. Проверка по утечкам (Have I Been Pwned) — внешний запрос с каждой регистрации, после MVP. Подтвердить минимум.
  **Ответ (человек, 2026-10-31):** по рекомендации.
- [x] **Q-11. Библиотеки.** *(Claude, 2026-10-31)*
  - **argon2:** а) `@node-rs/argon2` 2.2.2 — готовые бинарники под платформы, без сборки; б) `argon2` 0.45.1 — node-gyp и готовые бинарники.
  - **JWT:** `jose` 6.2.12 — без зависимостей, Ed25519, работает в Node и в браузере.
  - **SMTP:** `nodemailer` 10.1.2.
  - **cookie:** `@fastify/cookie` 11.1.3.

  **Рекомендация: «а» и остальные как названы.** Версии — последние, вышедшие не позже чем за две недели до 2026-10-31. Более новая патч-версия при реализации записывается отклонением в журнал. Лицензии: `jose` — MIT, `@node-rs/argon2` — MIT, `nodemailer` — MIT-0. Проверить при T-12, T-13, T-15.
  **Ответ (человек, 2026-10-31):** по рекомендации.
- [x] **Q-12. Экраны в 012.** *(Claude, 2026-10-31)*
  а) в 012 экранов нет, ссылка из письма ведёт на `IDENTITY_CONFIRM_URL` будущей страницы 014, ручная проверка идёт через `curl` и Mailpit; б) в 012 — временные страницы регистрации и входа в `apps/ui/cabinet`.
  **Рекомендация: «а».** Каркас с входом и маршрутизацией по правам — предмет 014. Временные страницы переделывались бы там целиком. S-1 через UI проходится после 014.
  **Ответ (человек, 2026-10-31):** по рекомендации.

## 10. Журнал реализации

Заполняет агент.

| Дата | Ветка / коммит | Что сделано | Отклонения от спеки |
|---|---|---|---|
