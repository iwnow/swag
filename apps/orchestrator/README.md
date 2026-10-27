# apps/orchestrator

Оболочка `orchestrator` (Fastify): HTTP для `api`, подписка на события роёв, уборка сирот при старте. Единственный сервис с доступом к Docker (Q-1).

## Задачи

- HTTP (спека 001, 4.6.1): `POST /swarms` → `202` (строгая схема, лишнее поле → `400`), `POST /swarms/:id/stop` → `202` / `404`, `GET /health`.
- Подписка `swarm.*.events` → `core.handleEvent` (agent.started, agent.result; остальные события, включая `llm.call`, ядро игнорирует).
- `cleanupOrphans` при старте (REQ-001-10).

## Что внутри сейчас

- `src/app.ts` — маршруты.
- `src/main.ts` — телеметрия (`adapter-telemetry`), `OrchestratorConfig`, адаптер Docker (`@swag/adapter-docker`, с адресом Collector для песочниц), шина NATS, часы и таймеры, запуск, остановка со сбросом телеметрии.
- Тесты: `test/health.test.ts` (AC-000-5, AC-001-12).

## Ограничения

- Порт наружу не публикуется: доступ только из сети compose.
- Docker socket монтируется только в этот сервис. Усиление — спека 005.

## Связи

- Ядро: `@swag/orchestrator-core`. Адаптеры: `@swag/adapter-docker`, `@swag/adapter-nats`, `@swag/adapter-telemetry`.
- HTTP-цепочка `api` → `orchestrator` с трассировкой проверяется в `apps/api/test/trace.test.ts` (AC-016-9).
- Конфигурация: `@swag/config`.

## Ключевые решения

- Доступ к Docker: сокет смонтирован только сюда (Q-1). Пользователь образа — `node`, но сокет на Docker Desktop принадлежит группе root: контейнеру добавлена группа `0` через `group_add` (без неё — `EACCES`, проверено в `npm run up`).
- `/swarms` возвращает `202` с пустым телом; `409` при повторном id, иначе `400` (AC-001-12).
- Порт наружу не публикуется: оркестратор — внутренний сервис, к нему ходит только `api` по сети compose (Q-7 спеки 001). `infra:check` проверяет `/health` изнутри контейнера через `docker compose exec`.

- Наблюдаемость (016): телеметрия поднимается до чтения остальной конфигурации; ошибка конфигурации или NATS — `error`-лог, сброс, выход с кодом 1. Fastify пишет тем же логгером; запросы, кроме `/health`, — серверные спаны с родителем из `traceparent` (`tracedHttpServer`). Таймеры роя наследуют контекст запуска (AsyncLocalStorage), поэтому события по таймаутам несут `traceId` запроса `POST /swarms`. Уборка сирот при старте — в своём спане `cleanup orphans` (новый трейс).
- `SIGTERM`/`SIGINT`: закрыть Fastify → NATS → сбросить телеметрию → `exit(0)`.

## Спеки

- 000 — `/health`. 001 — 4.6, T-8. 016 — 4.5, 4.7, REQ-016-5. 002 — оболочка получает только `.env` (REQ-002-5, AC-002-21); AC-002-22 — в `orchestrator-core`.
