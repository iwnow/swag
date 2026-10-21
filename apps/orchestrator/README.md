# @swag/orchestrator

Оболочка ядра `@swag/orchestrator-core`: внутренний HTTP-сервис на Fastify, который исполняет план роя — поднимает песочницы, сети, ключи и accounts шины, убирает ресурсы после роя.

## Задачи

- Принимает команды от `api` и вызывает операции `orchestrator-core`.
- Собирает для ядра адаптеры инфраструктуры: Docker (песочницы и сети), NATS (accounts шины), LiteLLM (виртуальные ключи), Postgres и S3 — по мере появления в спеках.
- Читает конфигурацию из env (`OrchestratorConfig` из `@swag/config`).
- Отдаёт `GET /health` для healthcheck в compose.

## Что внутри сейчас

Заглушка из спеки 000: `GET /health` → `{"status":"ok","service":"orchestrator","version":"…"}`.

- `src/main.ts` — точка входа: конфигурация, ядро, запуск сервера, остановка по сигналам.
- `src/app.ts` — `buildApp(core)`: Fastify-приложение и маршруты, тесты через `inject`.

## Ограничения

- Никакой логики исполнения плана в оболочке — алгоритмы живут в `orchestrator-core` ([архитектура](../../docs/architecture.md)).
- Пользователю напрямую недоступен: внешний вход — только через `api`.
- Docker socket сейчас не смонтирован. Доступ к Docker появится в спеке 004 вместе с отдельными мерами защиты: socket равен root на хосте.
- Порт `ORCHESTRATOR_PORT` публикуется только на `127.0.0.1`.

## Связи

- Использует: `@swag/orchestrator-core`, `@swag/config`, `fastify`.
- Запуск: сервис `orchestrator` в [compose.yaml](../../compose.yaml).

## Спеки

- 000 — заглушка с `/health`.
- 003, 004, 005, 008, 009 — ключи LiteLLM, песочницы и тёплый пул, снимки и reaper, шина, исполнение плана ([реестр](../../docs/spec/README.md#реестр-спек)).
