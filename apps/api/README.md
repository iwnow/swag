# apps/api

Оболочка `api` (Fastify): REST и WebSocket над `api-core`, сбор событий и сообщений из NATS.

## Задачи

- REST роёв (спека 001, 4.5.1): `POST /swarms`, `GET /swarms`, `GET /swarms/:id`, `GET /swarms/:id/events?after=`, `POST /swarms/:id/stop`, `GET /health`.
- `POST /swarms` требует `budgetMicroUsd` роя и принимает `budgetMicroUsd` агентов (спека 004, 4.1, 4.7). Предел — `SWARM_MAX_BUDGET_MICRO_USD` из `ApiConfig`, проверку делает ядро. `maxTokens` роя и агентов (спека 031, 4.1, 4.3) проверяется против `AGENT_MAX_TOKENS_LIMIT` из `ApiConfig`.
- WebSocket `GET /swarms/:id/stream?after=` (4.6): события с `seq > after`; неизвестный, невидимый рой или нет права — закрытие с кодом `4404`; нет токена, токен не прошёл проверку или отозван — `4401` (причина `unauthorized`).
- Проверка токена доступа (спека 024, 4.5): `Authorization: Bearer <jwt>` на всех REST-маршрутах, кроме `/health`. Видимость и права — в `api-core` по `Actor`.
- Подписки NATS `swarm.*.events` и `swarm.*.agent.*.inbox` → `ingestEvent` / `ingestMessage`. Событие `llm.call` от `llm-gateway` идёт по той же подписке (спека 002).

## Что внутри сейчас

- `src/app.ts` — маршруты и перевод результатов ядра в HTTP-ответы (`STATUS` по кодам ошибок).
- `src/auth.ts` — `createAuthenticator` (спека 024, 4.5, 4.6): верификатор подписи и kid (`@swag/adapter-jose`) → `RevocationSync.check` → `Actor` через `actorFromClaims`; `bearerToken` и `protocolToken` разбирают заголовок и подпротокол `swag.bearer.<jwt>`.
- `src/streams.ts` — `createStreamRegistry` (открытые потоки по `userId`, удаление при закрытии) и `createBlockHandler` — `onBlocked` для синхронизации: `stopSwarmsOfUser`, затем закрытие потоков пользователя кодом `4401` (в `finally`, ошибка уходит дальше).
- `src/revocations.ts` — `createRevocationSync` (спека 024, 4.12): синхронизация отзывов токенов из identity; `start` — первая синхронизация (reject при неудаче), затем интервал; `stop` снимает интервал; `check(claims)` → `ok` / `revoked` / `unavailable`. `fetchTokenRevocations` — `GET {IDENTITY_URL}/internal/token-revocations` с `IDENTITY_INTERNAL_TOKEN` и таймаутом.
- `src/start.ts` — `startApiCore`: миграции → пул Postgres → `SwarmStore` → ядро → `closeInterrupted` (спека 003, 4.5). Одна функция для `main.ts` и для теста AC-003-8; при ошибке миграций пишет `error` `migrations failed` и пробрасывает ошибку; если ошибка после создания пула (ядро, `closeInterrupted`), пул закрывается (`pool.end()`) до проброса. `startServer` — первая синхронизация отзывов с повтором через `API_REVOCATION_POLL_MS`, и только после неё `listen` (спека 024, 4.12).
- `src/main.ts` — телеметрия (`adapter-telemetry`), конфигурация (`ApiConfig`; лимиты ядра — `MAX_ACTIVE_SWARMS`, `SWARM_MAX_BUDGET_MICRO_USD` и `AGENT_MAX_TOKENS_LIMIT`), `startApiCore`, NATS, ключ проверки токенов (`IDENTITY_JWT_PUBLIC_KEY`, base64 от SPKI PEM), синхронизация отзывов, запуск. Остановка по сигналу: закрыть Fastify → NATS → `pool.end()` → сброс телеметрии → `exit(0)`. Слушает `0.0.0.0` внутри контейнера; наружу порт публикуется только на `127.0.0.1`.
- Тесты: `test/access.test.ts` (AC-024-15, 16, 18, 20, 21, 25 — токены подписываются тестовой парой Ed25519, синхронизация отзывов подменяется в памяти), `test/bench.test.ts` (NFR-024-2, только при `API_BENCH=1`), `test/revocations.test.ts` (AC-024-19 — отзывы, без Postgres и сети), `test/history.test.ts` (AC-003-8 — перезапуск на той же схеме; нужен `POSTGRES_TEST_URL`, без него пропускается), `test/health.test.ts` (AC-000-4), `test/api.test.ts` (AC-001-3, 4, 9, 10), `test/e2e.test.ts` (AC-022-21 и AC-001-20 — сквозной без Docker по сообщениям роя; AC-016-12, AC-016-13 — он же с настоящим `TraceContext`: один `traceId` на рой, нет утечки текста в логи и спаны; AC-030-6 — диалог двух агентов: ответ обработан отдельным ходом агента-входа, `unreadMessageIds` пуст), `test/trace.test.ts` (AC-016-9 — HTTP-цепочка `api` → `orchestrator` с настоящими серверами).

## Ограничения

- Токен принимается только если `api` сумел синхронизировать отзывы не позже `API_REVOCATION_MAX_STALE_MS` назад; иначе все маршруты роёв отвечают `503 auth_unavailable`, а WebSocket закрывается `4401`. Выдача токенов — в `identity`, `api` только проверяет.
- Отзыв действует до следующей синхронизации: окно не больше `API_REVOCATION_POLL_MS` + таймаут запроса к identity (3 с).
- Рои и события хранятся в Postgres (`DATABASE_URL`) и переживают перезапуск. Список роёв без пагинации (спека 003, Q-3).
- Миграции применяются при каждом старте `api` до приёма запросов; параллельные запуски ждут друг друга (блокировка `node-pg-migrate`). Вручную — `npm run db:migrate`.
- Рой, бывший `starting` или `running` в момент перезапуска, закрывается при старте `swarm.failed` с причиной `api_restarted` (спека 003, REQ-003-6). Пока `api` был остановлен, события роя из NATS потеряны (ядро NATS без JetStream).
- Логика не здесь: решения принимает `api-core`.
- Все обращения к ядру асинхронные: маршруты ждут его промисы, подписки NATS возвращают промис `ingestEvent` / `ingestMessage` (адаптер `adapter-nats` ждёт их по порядку поступления).

## Связи

- Ядро: `@swag/api-core`. Адаптеры: `@swag/adapter-postgres`, `@swag/adapter-orchestrator-http`, `@swag/adapter-nats`, `@swag/adapter-telemetry`.
- Конфигурация: `@swag/config`. Зависимости: `fastify`, `@fastify/websocket`, `pg`.
- Только для тестов (`devDependencies`): `@swag/adapter-memory`, `@swag/agent-core`, `@swag/orchestrator-core`, `@swag/ui-core` — см. ключевые решения.

## Ключевые решения

- Проверка токена (спека 024, T-13): REST-маршруты вынесены в дочерний плагин, где висит `onRequest`; `/health` и WebSocket вне него. WebSocket не проверяется в хуке: отказ из `onRequest` при апгрейде ушёл бы HTTP-ответом, а не закрытием `4401`. Токен WebSocket проверяется один раз при подключении; сервер выбирает подпротокол `swag.v1` (`handleProtocols`), если клиент его предложил. Освобождение потока (`close`, `error`) вешается до проверки токена и идемпотентно: если сокет закрылся во время проверки, поток не регистрируется и не подписывается.
- Причины отказа: `missing`, `invalid` (подпись, kid, iss, aud, срок — в верификаторе), `revoked`, `unavailable`. Для `missing`, `invalid` и `revoked` — `warn` `auth_failed` с `reason` без токена. Для `unavailable` тот же лог пишется с `reason: unavailable` (спека перечисляет три причины; отклонение, D-123). Ответы — `{ error: { code, message } }`, коды — `unauthorized` 401, `auth_unavailable` 503; `forbidden` 403 — из ядра.
- Таймаут запроса к identity — `IDENTITY_TIMEOUT_MS = 3000` в `main.ts`: короче, чем у оркестратора (`GATEWAY_TIMEOUT_MS` 10 с), потому что отзывы опрашиваются каждые 5 с. Константа, не переменная: 4.14 её не перечисляет.
- Клиент без `swag.v1`: `ws` при `handleProtocols` → `false` не отклоняет апгрейд, а принимает его без `Sec-WebSocket-Protocol`; клиент рвёт соединение сам и видит `1006`, а не `4401`. Серверный сокет при этом до закрытия TCP остаётся открытым с зарегистрированным потоком и подпиской (открыто, см. журнал T-13).
- Блокировка (4.12, правило 3): `onBlocked` закрывает потоки в `finally`, поэтому даже при сбое остановки роёв поток закрыт, а синхронизация повторяет вызов.
- Бенч NFR-024-2 (`API_BENCH=1`): «без проверки» — тот же маршрут и хук, но `authenticate` возвращает фиксированный `Actor`; разница — стоимость разбора и проверки токена. Два прогона, 200 запросов: p95 с проверкой 0.41–0.44 мс, без проверки 0.07–0.10 мс, разница 0.34 мс (порог 5 мс).
- Отзывы токенов (спека 024, T-12): таблица `userId → validAfter` заменяется целиком удачной синхронизацией; сбой — `warn` `revocations_sync_failed` без текста ошибки, таблица прежняя. Устаревание — `maxStaleMs` без удачной синхронизации (неудачные не продлевают свежесть) → `unavailable`. `onBlocked` вызывается для каждой пары `blocked: true` (userId, validAfter), которой нет в карте обработанных пар `handled`; пары, уже обработанные успешно, не повторяются. Сбой `onBlocked` — `warn` `revocation_block_failed` с `userId`, пара остаётся необработанной и повторяется на следующей синхронизации (безопасно: `stopSwarmsOfUser` идемпотентна). Разблокировка (`blocked: false`) или отсутствие записи убирает пару из `handled`. Вызовы `onBlocked` идут параллельно (`Promise.allSettled`). Повторный `start` не создаёт второй интервал, `stop` до `start` безопасен, `stop` во время синхронизации отменяет её вызовы. Зависший `onBlocked` держит синхронизацию: таймаута вызовов оркестратора в оболочке нет: спека его не задаёт (вопрос в журнале T-13). Тики не накладываются: пока синхронизация идёт, тик пропускается. Часы и таймеры — фейки в тесте (`test/revocations.test.ts`, AC-024-19).
- Сквозной тест (T-13, спека 022): песочница-фейк на `create` собирает `AgentConfigCore` из `spec.env` через `loadConfig(AgentConfig, env)` из `@swag/config` — тот же разбор, что в `apps/agent`. Адаптерные ключи `NATS_URL` и `LLM_GATEWAY_URL` в env оркестратора нет (их ставит `adapter-docker`), поэтому тест подставляет фейковые значения. Модель — скриптовый `ChatModel` на агента, сценарий 1 → 2 → 3 → 1 с `finish` у агента-входа; локальный в тесте, т.к. скриптовая модель из `agent-core/test` не экспортируется. Агент без участников получает модель, которая не отвечает: одиночный рой AC-016-12 ждёт остановки. Рёбра проверяются по `SwarmView.edges` через `api.getSwarm`.
- Хранилище роёв (спека 003, T-7): `main.ts` и тест AC-003-8 вызывают один `startApiCore` в одном порядке (4.5). Параметр `schema` есть только для тестов: он задаёт `search_path` пула и схему миграций (`test_<uuid>`); в работе не передаётся, схема — `public`. `pg` объявлен в `dependencies`, потому что оболочка сама создаёт пул.
- Остановка: `pool.end()` идёт после `bus.close()` и до сброса телеметрии. Ошибка старта (миграции, `closeInterrupted`) даёт два `error`-лога: `migrations failed` с причиной и `startup failed` (выход с кодом 1).
- `@swag/adapter-memory` переехал в `devDependencies`: `main.ts` его больше не импортирует, а тесты оболочки (`support.ts`, `e2e`, `trace`) — используют.
- Зависимости теста в `devDependencies` (N-13, спека 030, T-6): `e2e.test.ts` импортирует `agent-core`, `orchestrator-core` и `ui-core`, а сам сервис их не использует, поэтому в `dependencies` им не место. Раньше импорт работал только через hoisting воркспейсов и не был объявлен. `references` в `tsconfig.json` не нужны: `src` этих пакетов не импортирует, тесты проверяются `tsconfig.dev.json`.
- Сквозной тест диалога (AC-030-6): сценарий «agent-1 пишет agent-2 и уступает ход, agent-2 отвечает agent-1, agent-1 после ответа вызывает finish». Проверяется порядок `bus.message` и `agent.working` с тем же `messageId` в ленте и пустой результат `unreadMessageIds` для `completed`. Сценарий передаётся в `world(…, script)`; по умолчанию — сценарий AC-022-21.
- Fastify 5.12.7, `@fastify/websocket` 11.3.4 (точные версии); WebSocket на `ws` внутри плагина.
- Сверка с документацией (T-33 спеки 002, 2026-10-28). 5.12.7 — актуальная версия ветки v5 (https://fastify.dev/docs/latest/Reference/Server/): `listen({ host, port })`, `setErrorHandler`, `logLevel` маршрута — без изменений. `@fastify/websocket` 11.3.4 (https://github.com/fastify/fastify-websocket): регистрация до маршрутов, `{ websocket: true }`, обработчик `(socket, request)`, где `socket` — сам WebSocket (`send`, `on('close')`, `close(4404, …)`); пир-зависимость — Fastify 5.
- Ошибки ядра → HTTP: `validation_error` 400, `not_found` 404, `too_many_active_swarms` и `swarm_finished` 409 (`STATUS` в `app.ts`); ошибки формата тела Fastify приводятся к формату 4.5.3.
- Закрытие WebSocket с кодом `4404` для неизвестного роя (4.5.2).
- WebSocket (003, REQ-003-4): подписка асинхронна. Если сокет закрылся раньше, чем подписка установилась, отписка вызывается сразу после её получения.
- Адрес оркестратора — `ORCHESTRATOR_URL`; порт API публикуется только на `127.0.0.1` (compose).
- Наблюдаемость (016): телеметрия поднимается до чтения остальной конфигурации, поэтому ошибка конфигурации или подключения к NATS — `error`-лог `LogRecord`, сброс телеметрии, выход с кодом 1. Fastify пишет тем же логгером (`loggerInstance`), ошибки 5xx — `error request failed` с `err`. HTTP-сервер — `tracedHttpServer`: каждый запрос, кроме `/health`, идёт в серверном спане с родителем из `traceparent`; невалидный заголовок — новый трейс, ответ не меняется. Заголовок `traceparent` в ответ не добавляется (4.5).
- Сообщения NATS обрабатываются в спанах `consumer` адаптера: `bus.message` получает `traceId` сообщения агента.
- `SIGTERM`/`SIGINT`: закрыть Fastify → NATS → `pool.end()` → сбросить телеметрию (не дольше `TELEMETRY_FLUSH_TIMEOUT_MS`) → `exit(0)`.

## Спеки

- 000 — `/health`. 001 — 4.5, T-10. 024 — 4.5, 4.6, 4.12, T-12 (`revocations.ts`, AC-024-19), T-13 (`auth.ts`, `streams.ts`, `start.ts`, AC-024-15, 16, 18, 20, 21, 25, NFR-024-2). 016 — 4.5, REQ-016-5, AC-016-9. 002 — приём `llm.call` (REQ-002-15; AC-002-26 — тест в `api-core`). 003 — хранилище в Postgres и порядок старта (4.5, T-7, REQ-003-1, REQ-003-5, REQ-003-6, AC-003-8).
- 004 — бюджеты в `POST /swarms` (4.1, 4.7) и предел в `ApiConfig` (4.11); тесты оболочки передают бюджет в тела запросов (T-13).
