# apps/api

Оболочка `api` (Fastify): REST и WebSocket над `api-core`, сбор событий и сообщений из NATS.

## Задачи

- REST роёв (спека 001, 4.5.1): `POST /swarms`, `GET /swarms`, `GET /swarms/:id`, `GET /swarms/:id/events?after=`, `POST /swarms/:id/stop`, `GET /health`.
- WebSocket `GET /swarms/:id/stream?after=` (4.5.2): события с `seq > after`, неизвестный рой — закрытие с кодом `4404`.
- Подписки NATS `swarm.*.events` и `swarm.*.agent.*.inbox` → `ingestEvent` / `ingestMessage`.

## Что внутри сейчас

- `src/app.ts` — маршруты и перевод результатов ядра в HTTP-ответы (`STATUS` по кодам ошибок).
- `src/main.ts` — телеметрия (`adapter-telemetry`), конфигурация (`ApiConfig`), адаптеры (память, HTTP-оркестратор, NATS), запуск, остановка по сигналу со сбросом телеметрии. Слушает `0.0.0.0` внутри контейнера; наружу порт публикуется только на `127.0.0.1`.
- Тесты: `test/health.test.ts` (AC-000-4), `test/api.test.ts` (AC-001-3, 4, 9, 10), `test/e2e.test.ts` (AC-001-20 — сквозной без Docker; AC-016-12, AC-016-13 — он же с настоящим `TraceContext`: один `traceId` на рой, нет утечки текста в логи и спаны), `test/trace.test.ts` (AC-016-9 — HTTP-цепочка `api` → `orchestrator` с настоящими серверами).

## Ограничения

- Входа нет: один локальный пользователь (до спеки 012).
- Рои и события в памяти: после перезапуска теряются (до спеки 003).
- Логика не здесь: решения принимает `api-core`.

## Связи

- Ядро: `@swag/api-core`. Адаптеры: `@swag/adapter-memory`, `@swag/adapter-orchestrator-http`, `@swag/adapter-nats`, `@swag/adapter-telemetry`.
- Конфигурация: `@swag/config`. Зависимости: `fastify`, `@fastify/websocket`.

## Ключевые решения

- Fastify 5.12.7, `@fastify/websocket` 11.3.4 (точные версии); WebSocket на `ws` внутри плагина.
- Ошибки ядра → HTTP: `validation_error` 400, `not_found` 404, `too_many_active_swarms` и `swarm_finished` 409 (`STATUS` в `app.ts`); ошибки формата тела Fastify приводятся к формату 4.5.3.
- Закрытие WebSocket с кодом `4404` для неизвестного роя (4.5.2).
- Адрес оркестратора — `ORCHESTRATOR_URL`; порт API публикуется только на `127.0.0.1` (compose).
- Наблюдаемость (016): телеметрия поднимается до чтения остальной конфигурации, поэтому ошибка конфигурации или подключения к NATS — `error`-лог `LogRecord`, сброс телеметрии, выход с кодом 1. Fastify пишет тем же логгером (`loggerInstance`), ошибки 5xx — `error request failed` с `err`. HTTP-сервер — `tracedHttpServer`: каждый запрос, кроме `/health`, идёт в серверном спане с родителем из `traceparent`; невалидный заголовок — новый трейс, ответ не меняется. Заголовок `traceparent` в ответ не добавляется (4.5).
- Сообщения NATS обрабатываются в спанах `consumer` адаптера: `bus.message` получает `traceId` сообщения агента.
- `SIGTERM`/`SIGINT`: закрыть Fastify → NATS → сбросить телеметрию (не дольше `TELEMETRY_FLUSH_TIMEOUT_MS`) → `exit(0)`.

## Спеки

- 000 — `/health`. 001 — 4.5, T-10. 016 — 4.5, REQ-016-5, AC-016-9.
