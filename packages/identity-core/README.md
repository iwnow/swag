# @swag/identity-core

Ядро identity: регистрация компании, вход, сессии и токены, роли и первый супервизор (спека 012). Порт хранилища дополнен управлением доступом (спека 024, 4.9): список пользователей и организаций, блокировка, смена роли, приглашения, отзывы токенов, уборка. Операции 024 над портом (`authenticate`, приглашения, управление пользователями) — T-7…T-9, здесь пока не входят. Чистый TypeScript, не знает про HTTP, Fastify, Postgres, почту и криптобиблиотеки.

## Задачи

- Регистрация компании: ввод email → письмо со ссылкой подтверждения или «аккаунт уже есть», ответ одинаковый (спека 012, 4.2).
- Подтверждение регистрации: одноразовый токен из письма, пароль и название компании → организация и её `admin`.
- Вход, обновление и отзыв сессии по непрозрачному токену обновления, проверка токена доступа, `me`.
- Первый супервизор из конфигурации, если его ещё нет.
- Лимиты частоты по IP и email (спека 012, 4.8).

Реализовано полностью (спека 012, 4.2): `info()`, регистрация и подтверждение, вход, `me`, обновление и выход, первый супервизор. Заглушек нет.

## Что внутри сейчас

- `createIdentityCore(deps)` — фабрика ядра. `createIdentityCore` собирает все операции 4.2 и `info()`.
- Порты: `Clock`, `IdGenerator`, `Logger` (с `LogContext`), `IdentityStore`, `PasswordHasher`, `OpaqueTokens`, `TokenSigner`, `TokenVerifier`, `Mailer`, `RateLimiter`. Собраны в `IdentityCoreDeps`.
- `IdentityStore` (024, 4.9): `listUsers`, `updateUser`, `addInvitation`, `acceptInvitation`, `listOrganizations`, `tokenRevocations`, `purge` — сигнатуры 4.9, реализации в `@swag/adapter-memory` и `@swag/adapter-postgres`.
- `RETENTION_MS` — срок хранения закрытых записей для `purge`: 7 суток (Q-11, 024).
- Типы операций: `RequestMeta`, `IssuedSession`, `IdentityCore`, `IdentityError`, `Result<T>` (той же формы, что в `api-core`; код — из `AuthErrorCode`), `StoredUser` (с `blockedAt` и `tokensValidAfter`), `StoredOrganization`, `MailMessage`.
- Константы писем: `CONFIRM_MAIL_SUBJECT`, `ALREADY_REGISTERED_MAIL_SUBJECT`, `ALREADY_REGISTERED_MAIL_TEXT`, функция `confirmMailText(link, ttlHours)`.
- Константы лимитов: `RATE_LIMITS` — ключи `register:email`, `register:ip`, `confirm:ip`, `login:email`, `login:ip`, лимиты и окна в мс.
- Тесты: `test/identity-core.test.ts` — `info()`; `test/registration.test.ts` — `requestRegistration`, лимиты, письма; `test/confirm.test.ts` — `confirmRegistration`; `test/login.test.ts` — `login`, `me`, `dummyHash`, лимиты входа; `test/session.test.ts` — `refresh`, `logout`, сценарий без секретов в логах (AC-012-22, ядро); `test/supervisor.test.ts` — `ensureSupervisor`, вход супервизора; `test/fakes.ts` — общие фейки ядра (`createTestEnv`, часы, хэшер, токены, JWT, `tokenFromMail`, `sentMail`). Фейки: хэш `fake-hash:<пароль>`, токены — 43 цифры, JWT — `fake.<json>`, хранилище, почта и лимиты — из `@swag/adapter-memory` (как в тестах `api-core`).

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
- `refresh`: токен обновления меняется на каждом вызове; повтор заменённого токена отзывает сессию (`refresh_reuse_detected`). Если пользователя сессии нет, ответ — `invalid_refresh_token`.
- `logout`: нет токена или неизвестен — `ok`.
- `ensureSupervisor`: вызывается оболочкой до `listen`. Занятый email бросает ошибку, роль молча не меняется (Q-3).
- `me`: токен проверяет `TokenVerifier` (null — `unauthorized`), затем пользователь из `findUserById`.
- Неожиданное исключение порта — `internal_error`, событие `identity_operation_failed` с полем `operation` без `err` (4.3, D-115).

## Спеки

- 024 — 4.9, 4.10 (`RETENTION_MS`, константы 4.10 пока не объявлены); задача T-5 (порт и типы; поведение — T-7…T-9).
- 012 — 4.2, 4.3, 4.6, 4.8; задачи T-4 (REQ-012-1, AC-012-31), T-6 (регистрация, AC-012-4, AC-012-13, AC-012-25 — тесты в `test/registration.test.ts`), T-7 (подтверждение, AC-012-7, AC-012-8, AC-012-10 — `test/confirm.test.ts`), T-8 (вход и `me`, AC-012-12, AC-012-13 — `test/login.test.ts`), T-9 (обновление и выход, AC-012-15, AC-012-16 — `test/session.test.ts`), T-10 (супервизор, AC-012-20, AC-012-21 — `test/supervisor.test.ts`).
- 000 — правила ядра.
