# @swag/identity-core

Ядро identity: регистрация компании, вход, сессии и токены, роли, блокировка и первый администратор (спека 012). Чистый TypeScript, не знает про HTTP, Fastify, Postgres, почту и криптобиблиотеки.

## Задачи

- Регистрация компании: ввод email → письмо со ссылкой подтверждения или «аккаунт уже есть», ответ одинаковый (спека 012, 4.2).
- Подтверждение регистрации: одноразовый токен из письма, пароль и название компании → организация и её `admin`.
- Вход, обновление и отзыв сессии по непрозрачному токену обновления, проверка токена доступа, `me`.
- Первый супервизор из конфигурации, если его ещё нет.
- Лимиты частоты по IP и email (спека 012, 4.8).

Сейчас в пакете только каркас: порты, типы, константы писем и лимитов и `info()`. Операции возвращают `internal_error` (`not implemented`), `ensureSupervisor` бросает. Реализация идёт задачами T-6…T-10.

## Что внутри сейчас

- `createIdentityCore(deps)` — фабрика ядра. `info()` реализован; `requestRegistration`, `confirmRegistration`, `login`, `refresh`, `logout`, `me`, `ensureSupervisor` — заглушки.
- Порты: `Clock`, `IdGenerator`, `Logger` (с `LogContext`), `IdentityStore`, `PasswordHasher`, `OpaqueTokens`, `TokenSigner`, `TokenVerifier`, `Mailer`, `RateLimiter`. Собраны в `IdentityCoreDeps`.
- Типы операций: `RequestMeta`, `IssuedSession`, `IdentityCore`, `IdentityError`, `Result<T>` (той же формы, что в `api-core`; код — из `AuthErrorCode`), `StoredUser`, `StoredOrganization`, `MailMessage`.
- Константы писем: `CONFIRM_MAIL_SUBJECT`, `ALREADY_REGISTERED_MAIL_SUBJECT`, `ALREADY_REGISTERED_MAIL_TEXT`, функция `confirmMailText(link, ttlHours)`.
- Константы лимитов: `RATE_LIMITS` — ключи `register:email`, `register:ip`, `confirm:ip`, `login:email`, `login:ip`, лимиты и окна в мс.
- Тест: `test/identity-core.test.ts` — `info()` и заглушки.

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
- `LogContext` без email и секретов: поле `userId`, ошибка — в `err`. Контракт не запрещает передачу лишних полей на уровне типов, это проверяется ревью.
- Заглушки возвращают `internal_error` с сообщением `not implemented` вместо отсутствующих операций, чтобы оболочка компилировалась и могла подключаться до T-6…T-10.
- Лимиты и письма — константы ядра (012, Q-6, 4.6, 4.8). Срок ссылки подтверждения передаётся в текст письма числом часов.

## Спеки

- 012 — 4.2, 4.3, 4.6, 4.8; задача T-4 (REQ-012-1, AC-012-31: проверка через `arch:check`, вывод в журнал).
- 000 — правила ядра.
