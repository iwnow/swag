# apps/identity

Оболочка `identity` (Fastify): HTTP над `identity-core` для регистрации компаний, входа, обновления и выхода, проверки токена доступа. Логика — в ядре, здесь только перевод HTTP ↔ вызовы ядра и кодов ошибок ↔ статусы.

## Задачи

- Эндпоинты спеки 012, 4.4, под префиксом `/auth`: `POST /auth/registrations` (202, пустое тело), `POST /auth/registrations/confirm` (201 `AuthSession`), `POST /auth/login` (200), `POST /auth/refresh` (200 `AuthRefreshed`), `POST /auth/logout` (204), `GET /auth/me` (200 `AuthMe`), `GET /health` (`ServiceInfo`).
- Cookie токена обновления `swag_refresh` по 4.5: `HttpOnly; SameSite=Strict; Path=/auth; Max-Age=<IDENTITY_REFRESH_TTL_S>`, `Secure` только при `IDENTITY_COOKIE_SECURE=true`. Стирание — та же cookie с `Max-Age=0`.
- Старт по порядку: конфиг → миграции → пул → ядро → `ensureSupervisor` → `listen`. Занятый email супервизора или ошибка миграций — процесс не стартует с кодом 1.
- Управление доступом по спеке 024, 4.7: `GET /auth/users?orgId=` (200 `UserList`), `POST /auth/invitations` (202, пустое тело), `POST /auth/invitations/accept` (201 `AuthSession` + cookie и `no-store`), `PATCH /auth/users/:id` (200 `ManagedUser`), `GET /auth/organizations` (200 `OrganizationList`). Все, кроме принятия приглашения, требуют `Authorization: Bearer <jwt>`.
- `GET /internal/token-revocations` (024, 4.7): `Authorization: Bearer <IDENTITY_INTERNAL_TOKEN>`, `200 TokenRevocationList`; без токена или с неверным — `401 { error: { code: 'unauthorized', message: 'unauthorized' } }` (тот же формат, что у остальных ошибок). Маршрут не проксируется UI.
- Уборка просроченных и закрытых записей (024, 4.8): при старте (`onReady`) и раз в час; таймер снимается при закрытии приложения.
- Телеметрия: спаны на запросы (кроме `/health`), логи Fastify тем же логгером, `service: identity`.

## Что внутри сейчас

- `src/app.ts` — `buildApp(core, settings, options)`: маршруты 4.4 и 4.7, cookie 4.5, `STATUS` (коды ошибок → статусы), обработчик ошибок формата запроса, проверка внутреннего токена через `bearerMatches` из `@swag/helpers/server` (`timingSafeEqual`), уборка по расписанию (`onReady`, `setInterval` раз в час с `unref`, `onClose` снимает таймер). `settings.internalToken` — `IDENTITY_INTERNAL_TOKEN`.
- `src/start.ts` — `startIdentityCore` (миграции → пул → `createPostgresIdentityStore` → `createIdentityCore` → `ensureSupervisor`; при ошибке после создания пула пул закрывается), `startOrExit` (ошибка старта: одна запись `error` `startup failed`, затем `exit(1)`; `main.ts` передаёт сброс телеметрии и `process.exit`) и `jwtKeys` (декодирование ключа подписи, подпись и проверка).
- `src/main.ts` — телеметрия, `IdentityConfig`, ключи, адаптеры (argon2, opaque-токены, SMTP, ограничитель в памяти), старт, `listen` на `0.0.0.0` внутри контейнера (порт публикуется только на `127.0.0.1`), остановка по сигналу: закрыть Fastify → `pool.end()` → сброс телеметрии → `exit(0)`.
- Тесты: `test/stack.test.ts` (AC-012-27, NFR-012-2, только на поднятом контуре); `test/health.test.ts` (`/health` по 4.4), `test/registration.test.ts` (AC-012-5, 6, 25), `test/session.test.ts` (AC-012-11, 21), `test/cookie.test.ts` (AC-012-16, 17), `test/me.test.ts` (AC-012-18), `test/errors.test.ts` (AC-012-26), `test/logs.test.ts` (AC-012-22), `test/start.test.ts` (REQ-012-23; AC-012-20: `startOrExit` вызывает `exit(1)` и пишет одну запись `error` — нужен `POSTGRES_TEST_URL`, без него пропускается); `test/blocking.test.ts` (AC-024-6, 7), `test/management.test.ts` (AC-024-8, 11, 12), `test/invitation.test.ts` (AC-024-9, 10), `test/revocations.test.ts` (AC-024-13), `test/access-logs.test.ts` (AC-024-25), `test/purge.test.ts` (уборка при старте и сбой уборки). Общая обвязка — `test/support.ts`: ядро на адаптерах в памяти, настоящие argon2 и jose, телеметрия в памяти, хелперы приглашения и входа участника.

## Ключевые решения

- **Ключ подписи (D-117).** `IDENTITY_JWT_PRIVATE_KEY` — base64 от текста PKCS8 PEM. `jwtKeys` декодирует base64 в PEM, подписывает `createJoseSigner`, проверяет `createJoseVerifier` с открытым ключом, выведенным из закрытого (`publicKeyFromPrivate`). Другие сервисы получают открытый ключ отдельно (024). Ожидает подтверждения человека по D-117.
- **Порядок старта** (REQ-012-15, REQ-012-23): миграции и супервизор выполняются до `listen`, поэтому первый запрос не приходит к неготовой базе. `ensureSupervisor` вызывается из `startIdentityCore`, чтобы порядок проверял один код для `main.ts` и теста.
- **Коды ошибок → статусы.** `validation_error` и `invalid_token` — 400; `email_taken` — 409; `invalid_credentials`, `invalid_refresh_token`, `unauthorized` — 401; `rate_limited` — 429; `mail_unavailable` — 503; `internal_error` — 500. Тело — `{ error: { code, message, issues? } }` из ядра.
- **Ошибки формата запроса** (`413` по `IDENTITY_BODY_LIMIT_BYTES`, неверный JSON, неподдерживаемый тип) отдают `validation_error` с фиксированным текстом. В `AuthErrorCode` нет кода для `413`, поэтому статус 413 сохраняется, а код — `validation_error` (D-119: вариант с кодом `payload_too_large` ждёт приёмки 012). Текст ошибки парсера Fastify не отдаётся: он может содержать фрагмент тела с паролем.
- **Cookie.** `@fastify/cookie` 11.1.3 без подписи: токен обновления сам случаен и непрозрачен. `secure` задаётся явно, а не через `'auto'`, поэтому за прокси флаг не зависит от протокола запроса. Ответы с `accessToken` (201 и 200 у входа, подтверждения и обновления) несут `Cache-Control: no-store`. При `invalid_refresh_token` cookie стирается; при выходе стирается всегда.
- **Логи без секретов.** Сериализатор запросов телеметрии (`adapter-telemetry`) пишет только метод, путь без query и статус, поэтому `authorization`, `cookie` и тело в лог не попадают. Ядро не передаёт в лог email, пароль и токены. Тесты `logs.test.ts` проверяют полный сценарий по логам и спанам, заголовки и неверный JSON.
- **Ключ лимитов** — `request.ip` без `trustProxy`: за прокси UI все запросы могут получать один адрес (см. ограничения).
- **Внутренний токен (024, 4.7).** Сравнение через `timingSafeEqual` с предварительной проверкой длины, общее с `llm-gateway` и оркестратором (`@swag/helpers/server`). Токен — только в `Authorization`, в логах не пишется.
- **Уборка (024, 4.8, N-20).** Ошибка `purgeExpired` пишет `warn` `identity_purge_failed` без текста ошибки: текст ошибки Postgres может содержать email (N-23).
- **CORS не включён**: сервис стоит за прокси UI на том же origin (4.4).
- **Хэшер в тестах настоящий** (`createArgon2Hasher`): каждый вызов около 10 мс, зато AC-012-6 проверяется на реальной PHC-строке.

## Ограничения

- Лимиты частоты в памяти одного процесса (Q-6). Ключ по `request.ip`: без доверия к `X-Forwarded-For` все запросы через прокси UI имеют один IP, и лимит становится общим на всех пользователей. Решение — отдельный вопрос D-118 (настройка доверенного прокси), в 012 не решается. Если выбран `trustProxy`, доверять только адресу прокси: при прямом доступе к порту identity `X-Forwarded-For` подделывается и лимиты обходятся.
- HTTP-спаны в тестах не создаются: `app.inject` идёт мимо `serverFactory` (проверено), поэтому тесты `logs.test.ts` проверяют логи и отсутствие секретов в спанах, но не сами серверные спаны запросов.
- Логика не здесь: решения принимает `identity-core`.
- Миграции применяются при каждом старте до `listen`; параллельные запуски ждут друг друга (блокировка `node-pg-migrate`).
- Токен, выданный в ту же секунду, что и отзыв (`revokeAt`), отклоняется: `iat` в секундах, `validAfter` в миллисекундах, сравнение `iat * 1000 < validAfter` (024, 4.8, буквально). Окно — до одной секунды; тесты сдвигают часы. Вопрос к спеке — в журнале T-10.
- Тест `[stack]` (`test/stack.test.ts`) идёт по поднятому контуру и не запускается без `STACK_TEST_IDENTITY_URL` и `STACK_TEST_MAILPIT_URL`. Бенч входа NFR-012-2 — под `IDENTITY_BENCH=1`, на тех же переменных: 10 серий по 10 входов супервизора, перед каждой серией и после последней identity перезапускается (`docker compose restart identity`), потому что лимиты 4.8 (`login:email` 10 за 15 мин) не дают 100 последовательных входов одного супервизора (трактовка D-120, см. журнал T-18).
- Образ — `apps/identity/Dockerfile` (как `apps/api`, пакеты identity); в `compose.yaml` — сервисы `identity` и `mailpit` (порт `127.0.0.1:${IDENTITY_PORT}`, UI Mailpit на `127.0.0.1:${MAILPIT_UI_PORT}`).

## Связи

- Контейнер: `apps/identity/Dockerfile`, compose — `identity` и `mailpit` (`axllent/mailpit:v1.31.6`).
- Ядро: `@swag/identity-core`. Адаптеры: `@swag/adapter-crypto`, `@swag/adapter-jose`, `@swag/adapter-memory` (ограничитель), `@swag/adapter-postgres`, `@swag/adapter-smtp`, `@swag/adapter-telemetry`.
- Конфигурация: `@swag/config` (`IdentityConfig`). Контракты: `@swag/contracts`.
- Зависимости: `fastify` 5.12.7, `@fastify/cookie` 11.1.3, `pg` 8.23.1.

## Спеки

- 000 — `/health`, 016 — телеметрия и спаны. 012 — 4.4, 4.5, 4.9–4.11, REQ-012-12, 13, 20, 22, 23; AC-012-5, 6, 11, 16, 17, 18, 20, 21, 22, 25, 26, 27 (`[stack]`); NFR-012-2; REQ-012-21 (compose).
- 024 — 4.7 (маршруты и внутренний токен), 4.8 (уборка в оболочке), T-10; AC-024-6…13, AC-024-25 (identity).
