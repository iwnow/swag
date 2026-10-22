# apps/orchestrator

Оболочка `orchestrator` (Fastify): HTTP для `api`, подписка на события роёв, уборка сирот при старте. Единственный сервис с доступом к Docker (Q-1).

## Задачи

- HTTP (спека 001, 4.6.1): `POST /swarms` → `202` (строгая схема, лишнее поле → `400`), `POST /swarms/:id/stop` → `202` / `404`, `GET /health`.
- Подписка `swarm.*.events` → `core.handleEvent` (agent.started, agent.result).
- `cleanupOrphans` при старте (REQ-001-10).

## Что внутри сейчас

- `src/app.ts` — маршруты.
- `src/main.ts` — `OrchestratorConfig`, адаптер Docker (`@swag/adapter-docker`), шина NATS, часы и таймеры, запуск.
- Тесты: `test/health.test.ts` (AC-000-5, AC-001-12).

## Ограничения

- Порт наружу не публикуется: доступ только из сети compose.
- Docker socket монтируется только в этот сервис. Усиление — спека 005.

## Связи

- Ядро: `@swag/orchestrator-core`. Адаптеры: `@swag/adapter-docker`, `@swag/adapter-nats`.
- Конфигурация: `@swag/config`.

## Ключевые решения

- Доступ к Docker: сокет смонтирован только сюда (Q-1). Пользователь образа — `node`, но сокет на Docker Desktop принадлежит группе root: контейнеру добавлена группа `0` через `group_add` (без неё — `EACCES`, проверено в `npm run up`).
- `/swarms` возвращает `202` с пустым телом; `409` при повторном id, иначе `400` (AC-001-12).
- Порт оркестратора публикуется на `127.0.0.1`, потому что `infra:check` 000 проверяет его с хоста. Это расходится с 001 4.6.1 (порт не публикуется) — см. Q-7 в спеке.

## Спеки

- 000 — `/health`. 001 — 4.6, T-8.
