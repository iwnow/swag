# @swag/identity-core

Ядро identity: регистрация компании, вход, сессии и токены, роли и первый супервизор (спека 012), блокировка и список пользователей и организаций (спека 024). Порт хранилища дополнен управлением доступом (024, 4.9): список пользователей и организаций, блокировка, смена роли, приглашения, отзывы токенов, уборка. Ядро управления доступом (024, 4.8) закрыто: маршруты HTTP и проверка внутреннего токена — в `apps/identity` (T-10). Чистый TypeScript, не знает про HTTP, Fastify, Postgres, почту и криптобиблиотеки.

## Задачи

- Регистрация компании: ввод email → письмо со ссылкой подтверждения или «аккаунт уже есть», ответ одинаковый (спека 012, 4.2).
- Подтверждение регистрации: одноразовый токен из письма, пароль и название компании → организация и её `admin`.
- Вход, обновление и отзыв сессии по непрозрачному токену обновления, проверка токена доступа, `me`.
- Первый супервизор из конфигурации, если его ещё нет.
- Лимиты частоты по IP и email (спека 012, 4.8).
- Блокировка пользователя: заблокированный не входит, не обновляет сессию и не работает ни одним токеном (спека 024, 4.8).
- Список пользователей (`listUsers`) и организаций (`listOrganizations`) по правам и области видимости (спека 024, 4.8).
- Приглашение пользователя администратором организации письмом со ссылкой и принятие приглашения с выдачей сессии (спека 024, 4.8, 4.10).
- Смена роли и блокировка пользователя (`updateUser`) администратором своей организации или супервизором (спека 024, 4.8).
- Отзывы токенов для `api` (`tokenRevocations`) и уборка просроченных записей (`purgeExpired`), спека 024, 4.9.

Реализовано: `info()`, регистрация и подтверждение, вход, `me`, обновление и выход, первый супервизор, блокировка, `listUsers`, `listOrganizations`, `inviteUser`, `acceptInvitation`, `updateUser`, `tokenRevocations`, `purgeExpired`. Заглушек нет.

## Что внутри сейчас

- `createIdentityCore(deps)` — фабрика ядра. `createIdentityCore` собирает все операции 4.2 и `info()`.
- Порты: `Clock`, `IdGenerator`, `Logger` (с `LogContext`), `IdentityStore`, `PasswordHasher`, `OpaqueTokens`, `TokenSigner`, `TokenVerifier`, `Mailer`, `RateLimiter`. Собраны в `IdentityCoreDeps`.
- `IdentityStore` (024, 4.9): `listUsers`, `updateUser`, `addInvitation`, `acceptInvitation`, `listOrganizations`, `tokenRevocations`, `purge` — сигнатуры 4.9, реализации в `@swag/adapter-memory` и `@swag/adapter-postgres`.
- `RETENTION_MS` — срок хранения закрытых записей для `purge`: 7 суток (Q-11, 024).
- Константы приглашения: `INVITATION_MAIL_SUBJECT`, `invitationMailText(orgName, link, ttlHours)`; лимит `RATE_LIMITS.inviteUser` — ключ `invite:user`, 20 за 1 ч, по `userId` автора.
- Типы операций: `RequestMeta`, `IssuedSession`, `IdentityCore`, `IdentityError`, `Result<T>` (той же формы, что в `api-core`; код — из `AuthErrorCode`), `StoredUser` (с `blockedAt` и `tokensValidAfter`), `StoredOrganization`, `MailMessage`.
- Операции 024 (T-7): `listUsers(accessToken, query)` → `UserList`, `listOrganizations(accessToken)` → `OrganizationList`; внутренняя `authenticate(accessToken)` возвращает `Actor` (через `actorFromClaims`), пользователя и организацию из хранилища.
- Константы писем: `CONFIRM_MAIL_SUBJECT`, `ALREADY_REGISTERED_MAIL_SUBJECT`, `ALREADY_REGISTERED_MAIL_TEXT`, функция `confirmMailText(link, ttlHours)`.
- Константы лимитов: `RATE_LIMITS` — ключи `register:email`, `register:ip`, `confirm:ip`, `login:email`, `login:ip`, лимиты и окна в мс.
- Тесты: `test/identity-core.test.ts` — `info()`; `test/registration.test.ts` — `requestRegistration`, лимиты, письма; `test/confirm.test.ts` — `confirmRegistration`; `test/login.test.ts` — `login`, `me`, `dummyHash`, лимиты входа; `test/session.test.ts` — `refresh`, `logout`, сценарий без секретов в логах (AC-012-22, ядро); `test/supervisor.test.ts` — `ensureSupervisor`, вход супервизора; `test/access.test.ts` — блокировка при входе и `refresh`, отзыв токенов при блокировке и смене роли, роль из хранилища, `listUsers`, `listOrganizations` (024, AC-024-6…8, AC-024-12); `test/invitation.test.ts` — `inviteUser`, `acceptInvitation` (024, AC-024-9, AC-024-10 на ядре); `test/management.test.ts` — `updateUser` (AC-024-11 на ядре), `tokenRevocations` (окно `accessTtl`); `test/purge.test.ts` — `purgeExpired` (AC-024-14); `test/fakes.ts` — общие фейки ядра (`createTestEnv`, часы, хэшер, токены, JWT, `tokenFromMail`, `sentMail`, посев `seedAdmin`, `seedOrganization`, `addMember`, `loginAs`). Фейки: хэш `fake-hash:<пароль>`, токены — 43 цифры, JWT — `fake.<json>`, хранилище, почта и лимиты — из `@swag/adapter-memory` (как в тестах `api-core`).

## Ограничения

Правила ядра ([архитектура](../../docs/architecture.md), [спека 000, 4.2](../../docs/spec/000-foundation.md#42-правила-ядра-и-оболочки)):

- Зависимости — только `zod` и `@swag/contracts`.
- Нет `node:*`, `process`, env, файлов, сети, `jose`, `@node-rs/argon2`, `nodemailer`: криптография, подпись и почта — через порты.
- `tsconfig` без `@types/node` и DOM.

Проверяют `npm run arch:check` и `npm run typecheck`.

## Связи

- Оболочка: `apps/identity` (T-16).
- Адаптеры портов: `@swag/adapter-memory` (хранилище, почта, ограничитель для тестов), `@swag/adapter-postgres` (хранилище, T-11), `@swag/adapter-crypto` (хэш и токены, T-12), `@swag/adapter-jose` (подпись, T-13), `@swag/adapter-smtp` (почта, T-15).
- Использует: `@swag/contracts` (схемы `auth.ts`, `ServiceInfo`, `AccessTokenClaims`, `AuthSession`, `AuthMe`, `AuthRefreshed`, `AuthErrorCode`, `Role`).

## Ключевые решения

- `Result` и `IdentityError` объявлены в пакете, а не импортируются из `api-core`: ядро зависит только от `zod` и `@swag/contracts`. Форма та же, что в `api-core`.
- `LogContext` без email и секретов: ядро пишет только `userId`, `operation` (имя операции) и `limit` (имя правила лимита); текст ошибки в лог не попадает, поле `err` ядро не передаёт (4.3, D-115). Контракт не запрещает передачу лишних полей на уровне типов, это проверяется ревью.
- Лимиты и письма — константы ядра (012, Q-6, 4.6, 4.8).
- Срок ссылки подтверждения в письме — число часов, округлённое вверх (D-113, вариант б): 600 с → 1 ч, 5400 с → 2 ч.
- `requestRegistration`: сначала лимит по IP, потом по email (одна попытка расходует оба). Ответ один и тот же для нового и существующего email (Q-9).
- Почта: при ошибке отправки лог `mail_send_failed` без поля `err` — текст ошибки SMTP может содержать адрес (D-115).
- Подтверждение: сначала лимит `confirm:ip`, затем хэш пароля и одна операция хранилища `confirmRegistration`. Погашенный, просроченный и неизвестный токен дают один ответ `invalid_token`; занятый email — `email_taken`, токен при этом не гасится.
- `issueSession` (внутренняя): токен обновления — непрозрачный, в хранилище только SHA-256; токен доступа подписывает `TokenSigner` с `iat = floor(now/1000)`, `exp = iat + accessTtl`.
- `login`: сначала лимит `login:ip`, потом `login:email`. Неверный пароль и неизвестный email дают один ответ `invalid_credentials`; `hasher.verify` вызывается ровно один раз в обоих случаях: на неизвестный email — с `dummyHash` (хэш от случайной строки, считается один раз и кешируется).
- `login` (024): после верного пароля заблокированный получает `user_blocked` и лог `warn` `login_blocked` с `userId`; неверный пароль проверяется первым и даёт `invalid_credentials` независимо от блокировки.
- Приглашение (024): `inviteUser` — только роль `admin` организации (роль `user` и `supervisor` — `forbidden`; `admin` без организации — тоже `forbidden`). Существующий email — письмо «аккаунт уже есть» без приглашения (ответ `ok`). Приглашение хранит только хэш токена; срок — `IDENTITY_INVITE_TTL_S`, в письме часы округлены вверх (как D-113). Лимит 20 за час по `userId` автора; ключ с email в лог не пишется.
- `acceptInvitation`: лимит `confirm:ip` как у подтверждения; ответ `invalid_token` (погашено, просрочено, неизвестно) — лог `warn` `invite_invalid_token`; занятый email — `email_taken`, приглашение не гасится. Пароль хэшируется до операции хранилища; сессия выдаётся с ролью приглашения и организацией администратора.
- `updateUser` (024, 4.8): порядок проверок — право `user.manage`, разбор тела, поиск цели (нет — `not_found`), затем сам себе или супервизор — `forbidden` (AC-024-11 требует `403` для администратора, который меняет супервизора; буква 4.8 дала бы `not_found` из-за чужой организации, см. журнал), затем администратор и чужая организация — `not_found`. `blocked: true` ставит `blockedAt = now` даже у уже заблокированного; `revokeAt = now` — только при новой блокировке или смене роли на другую.
- `tokenRevocations`: записи с `validAfter` новее `now - accessTtl` (в мс); старые не возвращаются.
- `purgeExpired`: `purge(now - RETENTION_MS)`, лог `info` `identity_purged` с числами удалённых записей; вызов оболочкой — при старте и раз в час.
- `refresh`: токен обновления меняется на каждом вызове; повтор заменённого токена отзывает сессию (`refresh_reuse_detected`). Если пользователя сессии нет или он заблокирован, ответ — `invalid_refresh_token` (024).
- `logout`: нет токена или неизвестен — `ok`.
- `ensureSupervisor`: вызывается оболочкой до `listen`. Занятый email бросает ошибку, роль молча не меняется (Q-3).
- `authenticate` (024, внутренняя): `TokenVerifier` (null — `unauthorized`), затем `findUserById(sub)`; нет пользователя, `blockedAt !== null` или `iat * 1000 < tokensValidAfter` — `unauthorized`. Роль и организация берутся из хранилища, а не из токена: токен со старой ролью после смены роли не даёт прав. `me` работает через `authenticate` (ответ как в 012).
- `listUsers`: `admin` — только своя организация, `query.orgId` игнорируется; `supervisor` — все или `orgId`; нет права `user.manage` — `forbidden`. `admin` без организации (контракт не допускает) — `forbidden`, а не список всех. `listOrganizations`: право `organization.read` (только супервизор), `userCount` — из хранилища. Маппинг `StoredUser` → `ManagedUser` (`blocked = blockedAt !== null`, `createdAt` ISO) и организации → `OrganizationSummary` — по одной функции на каждый тип, без дублей.
- Пароль и хэш в ответах `listUsers` не попадают: `ManagedUser` строится явно по полям.
- Неожиданное исключение порта — `internal_error`, событие `identity_operation_failed` с полем `operation` без `err` (4.3, D-115).

## Спеки

- 024 — 4.8 (`authenticate`, `login`, `refresh`, `listUsers`, `listOrganizations`, `inviteUser`, `acceptInvitation`, `updateUser`, `tokenRevocations`, `purgeExpired`), 4.9, 4.10 (`RETENTION_MS`, лимит `invite:user`); задачи T-5 (порт и типы), T-7 (`test/access.test.ts`: AC-024-6, AC-024-7, AC-024-8, AC-024-12 на ядре), T-8 (`test/invitation.test.ts`: AC-024-9, AC-024-10 на ядре), T-9 (`test/management.test.ts`: AC-024-11 на ядре; `test/purge.test.ts`: AC-024-14). Маршруты и внутренний токен — T-10.
- 012 — 4.2, 4.3, 4.6, 4.8; задачи T-4 (REQ-012-1, AC-012-31), T-6 (регистрация, AC-012-4, AC-012-13, AC-012-25 — тесты в `test/registration.test.ts`), T-7 (подтверждение, AC-012-7, AC-012-8, AC-012-10 — `test/confirm.test.ts`), T-8 (вход и `me`, AC-012-12, AC-012-13 — `test/login.test.ts`), T-9 (обновление и выход, AC-012-15, AC-012-16 — `test/session.test.ts`), T-10 (супервизор, AC-012-20, AC-012-21 — `test/supervisor.test.ts`).
- 000 — правила ядра.
