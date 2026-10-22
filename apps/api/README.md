# apps/api

Оболочка `api` (Fastify): REST и WebSocket над `api-core`, сбор событий и сообщений из NATS.

## Задачи

- REST роёв (спека 001, 4.5.1): `POST /swarms`, `GET /swarms`, `GET /swarms/:id`, `GET /swarms/:id/events?after=`, `POST /swarms/:id/stop`, `GET /health`.
- WebSocket `GET /swarms/:id/stream?after=` (4.5.2): события с `seq > after`, неизвестный рой — закрытие с кодом `4404`.
- Подписки NATS `swarm.*.events` и `swarm.*.agent.*.inbox` → `ingestEvent` / `ingestMessage`.

## Что внутри сейчас

- `src/app.ts` — маршруты и перевод результатов ядра в HTTP-ответы (`STATUS` по кодам ошибок).
- `src/main.ts` — конфигурация (`ApiConfig`), адаптеры (память, HTTP-оркестратор, NATS), запуск. Слушает `0.0.0.0` внутри контейнера; наружу порт публикуется только на `127.0.0.1`.
- Тесты: `test/health.test.ts` (AC-000-4), `test/api.test.ts` (AC-001-3, 4, 9, 10).

## Ограничения

- Входа нет: один локальный пользователь (до спеки 012).
- Рои и события в памяти: после перезапуска теряются (до спеки 003).
- Логика не здесь: решения принимает `api-core`.

## Связи

- Ядро: `@swag/api-core`. Адаптеры: `@swag/adapter-memory`, `@swag/adapter-orchestrator-http`, `@swag/adapter-nats`.
- Конфигурация: `@swag/config`. Зависимости: `fastify`, `@fastify/websocket`.

## Ключевые решения

- Fastify 5.12.7, `@fastify/websocket` 11.3.4 (точные версии); WebSocket на `ws` внутри плагина.
- Ошибки ядра → HTTP: `validation_error` 400, `not_found` 404, `too_many_active_swarms` и `swarm_finished` 409 (`STATUS` в `app.ts`); ошибки формата тела Fastify приводятся к формату 4.5.3.
- Закрытие WebSocket с кодом `4404` для неизвестного роя (4.5.2).
- Адрес оркестратора — `ORCHESTRATOR_URL`; порт API публикуется только на `127.0.0.1` (compose).

## Спеки

- 000 — `/health`. 001 — 4.5, T-10.
