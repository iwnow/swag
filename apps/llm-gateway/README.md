# @swag/llm-gateway

Оболочка LLM Gateway (спека 002): Fastify-процесс. Читает конфигурацию и каталог моделей, собирает адаптеры LiteLLM и NATS, вызывает фабрику ядра `createLlmGatewayCore` и на старте сверяет каталог с апстримом. Решений здесь нет: логика живёт в `packages/llm-gateway-core`.

## Задачи

- Старт: конфигурация `LlmGatewayConfig` (env, `@swag/config`), каталог моделей из `LLM_CATALOG_PATH` (`readCatalog`, схема `ModelCatalog`), секреты адаптера (`upstreamSecrets`), адаптер LiteLLM (`createLiteLlmUpstream`), шина NATS для события `llm.call` в `swarm.<swarmId>.events`.
- Сверка при старте (REQ-002-13): `checkUpstream` повторяется раз в 1 с до `LLM_GATEWAY_STARTUP_TIMEOUT_MS`. Пока сверка не прошла, порт не слушается.
  - Модели каталога не хватает → `error` `upstream_models_mismatch` с `missing`, выход с кодом 1.
  - Апстрим не ответил → `error` `upstream_unavailable` с `reason`, выход с кодом 1 (D-64).
- `GET /health` → `200 { status: 'ok', service: 'llm-gateway', version }`.

## Что внутри сейчас

- `src/main.ts` — телеметрия (`startTelemetry`, сервис `llm-gateway`), конфигурация, каталог, NATS, адаптер, ядро, запуск, остановка по `SIGINT`/`SIGTERM`. Слушает `0.0.0.0` внутри контейнера.
- `src/start.ts` — `startGateway` (сверка, затем `listen`, либо выход 1), `waitForUpstream` (повтор раз в 1 с до таймаута), `upstreamSecrets`.
- `src/catalog.ts` — `readCatalog`: читает файл и проверяет его схемой `ModelCatalog`.
- `src/app.ts` — `buildApp`: Fastify с `GET /health`.
- `test/start.test.ts` — AC-002-18 (в апстриме нет `chat-large`: порт не слушает, `upstream_models_mismatch` с `missing`, выход 1; полный список: `/health` → `200`), повтор сверки, `upstreamSecrets`, `readCatalog`. Апстрим — фейк `infra/llm/fake-provider/server.ts`, каталог — `test/fixtures/catalog.json`.

## Ограничения

- Только `GET /health`. Проверки токена, `/v1/models`, `/v1/chat/completions`, `bodyLimit`, SSE — T-21…T-23.
- Телеметрия только для логгера и `TraceContext`: хуки Fastify и `tracedHttpServer` — T-24. Dockerfile — T-25.
- Каталог читается один раз при старте; смена каталога требует перезапуска.
- Полный запуск (`main.ts`) требует NATS и LiteLLM; в тестах не запускается, проверяется `startGateway` с фейком.

## Связи

- Ядро: `@swag/llm-gateway-core`. Адаптеры: `@swag/adapter-litellm`, `@swag/adapter-nats`, `@swag/adapter-telemetry`.
- Конфигурация: `@swag/config`. Контракт каталога и событий: `@swag/contracts`.
- Фреймворк: `fastify` 5.12.7 (как в `apps/api`).

## Ключевые решения

- Порт слушается только после успешной сверки (REQ-002-13): `startGateway` вызывает `listen` последним.
- Каждый вызов сверки ограничивается таймаутом простоя адаптера (`LLM_GATEWAY_UPSTREAM_TIMEOUT_MS`), а не остатком срока старта: иначе последняя попытка обрывалась бы через миллисекунды и давала ложный `network` вместо результата сверки.
- Выход процесса внедряется в `startGateway` (`exit`): тесты не вызывают `process.exit`.
- Телеметрия поднимается первой, как в `apps/api`: ошибка конфигурации и каталога уходит логом `error` до выхода.
- Событие `llm.call` публикуется в `swarm.<swarmId>.events` через `connectNatsBus.publishJson`.
- Секреты адаптера (4.9): мастер-ключ LiteLLM и непустые значения переменных `*_API_KEY`; они редактируются в сообщениях ошибок адаптера.
- `version` берётся из `package.json`, как в `apps/api`.

## Спеки

- 002 — 4.2 (`/health`), 4.9, 4.14; REQ-002-13; AC-002-18; задача T-20.
