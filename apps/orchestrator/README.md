# apps/orchestrator

Оболочка `orchestrator` (Fastify): HTTP для `api`, подписка на события роёв, уборка сирот при старте. Единственный сервис с доступом к Docker (Q-1).

## Задачи

- HTTP (спека 001, 4.6.1): `POST /swarms` → `202` (строгая схема, лишнее поле → `400`), `POST /swarms/:id/stop` → `202` / `404`, `GET /health`.
- Авторизация (спека 024, 4.13): на всех маршрутах, кроме `GET /health`, `Authorization: Bearer <ORCHESTRATOR_TOKEN>` в `onRequest`; без токена или с неверным — `401 { error: { code: 'unauthorized', message } }`, рой не запускается и не останавливается.
- Подписка `swarm.*.events` → `core.handleEvent` (agent.started, agent.result; остальные события, включая `llm.call`, ядро игнорирует).
- `cleanupOrphans` при старте (REQ-001-10).

## Что внутри сейчас

- `src/app.ts` — маршруты и хук `onRequest` с проверкой `ORCHESTRATOR_TOKEN` (`buildApp(core, options, { token })`).
- `src/main.ts` — телеметрия (`adapter-telemetry`), `OrchestratorConfig`, адаптер Docker (`@swag/adapter-docker`, с адресом Collector для песочниц и адресом llm-gateway), адаптер регистрации роёв в gateway (`@swag/adapter-gateway-http`, `LLM_GATEWAY_URL`, `LLM_GATEWAY_TOKEN`, таймаут 10 с — константа `GATEWAY_TIMEOUT_MS`, D-99), шина NATS, часы и таймеры, `deps.agent` ядра (лимиты агента, токен gateway, таймаут flush из конфигурации), запуск, остановка со сбросом телеметрии.
- Тесты: `test/health.test.ts` (AC-000-5, AC-001-12; фейк `llmSwarms`), `test/auth.test.ts` (AC-024-22: без токена и с неверным — `401`, ядро не вызвано; с верным — как раньше; `/health` без токена — `200`), общая фабрика ядра и токен — `test/support.ts`.

## Ограничения

- Порт наружу не публикуется: доступ только из сети compose.
- Docker socket монтируется только в этот сервис. Усиление — спека 005.

## Связи

- Ядро: `@swag/orchestrator-core`. Адаптеры: `@swag/adapter-docker`, `@swag/adapter-gateway-http`, `@swag/adapter-nats`, `@swag/adapter-telemetry`. Хелпер: `bearerMatches` из `@swag/helpers/server`.
- HTTP-цепочка `api` → `orchestrator` с трассировкой проверяется в `apps/api/test/trace.test.ts` (AC-016-9).
- Конфигурация: `@swag/config`.

## Ключевые решения

- Доступ к Docker: сокет смонтирован только сюда (Q-1). Пользователь образа — `node`, но сокет на Docker Desktop принадлежит группе root: контейнеру добавлена группа `0` через `group_add` (без неё — `EACCES`, проверено в `npm run up`).
- `/swarms` возвращает `202` с пустым телом; `409` при повторном id, иначе `400` (AC-001-12).
- Токен проверяется до разбора тела и до ядра (024, 4.13): чужой запрос не читается целиком и не доходит до `launch`/`stop`. Сравнение — `timingSafeEqual`, значение заголовка в логи не пишется. Маршрут определяется по `routeOptions.url`, поэтому неизвестный путь без токена тоже отвечает `401`, а не `404`.
- Порт наружу не публикуется: оркестратор — внутренний сервис, к нему ходит только `api` по сети compose (Q-7 спеки 001). `infra:check` проверяет `/health` изнутри контейнера через `docker compose exec`.
- Оркестратор стартует после `llm-gateway` (`service_healthy` в `compose.yaml`, 022, 4.8): песочницы агентов без gateway бессмысленны. Эстафеты `AGENT_NEXT` и `AGENT_STEP_DELAY_MS` в конфигурации больше нет (022, 4.8).

- Наблюдаемость (016): телеметрия поднимается до чтения остальной конфигурации; ошибка конфигурации или NATS — `error`-лог, сброс, выход с кодом 1. Fastify пишет тем же логгером; запросы, кроме `/health`, — серверные спаны с родителем из `traceparent` (`tracedHttpServer`). Таймеры роя наследуют контекст запуска (AsyncLocalStorage), поэтому события по таймаутам несут `traceId` запроса `POST /swarms`. Уборка сирот при старте — в своём спане `cleanup orphans` (новый трейс).
- `SIGTERM`/`SIGINT`: закрыть Fastify → NATS → сбросить телеметрию → `exit(0)`.

## Спеки

- 000 — `/health`. 024 — 4.13, REQ-024-11, AC-024-22 (`ORCHESTRATOR_TOKEN`). 004 — 4.6 (регистрация роя в gateway при `launch`, закрытие при `finish`), 4.11 (`LLM_GATEWAY_URL`), REQ-004-3. 001 — 4.6, T-8. 022 — 4.8, 4.9 (env агента, `LLM_GATEWAY_URL` из конфигурации, AC-022-17 — часть оболочки). 016 — 4.5, 4.7, REQ-016-5. 002 — оболочка получает только `.env` (REQ-002-5, AC-002-21); AC-002-22 — в `orchestrator-core`.
