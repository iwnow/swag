# @swag/config

Чтение env и проверка Zod-схемами (спека 000, REQ-000-9). Только для оболочек: ядра получают уже проверенные значения аргументами.

## Задачи

- `loadConfig(schema, env)` — разобрать env; ошибка — `ConfigError` с именем переменной.
- Схемы сервисов: `BaseConfig`, `ApiConfig`, `OrchestratorConfig`, `AgentConfig`, `UiConfig`, `ObservabilityConfig`.

## Что внутри сейчас

- `BaseConfig` — `DATABASE_URL`, `NATS_URL`; телеметрия (спека 016, 4.11): `OTEL_EXPORTER_OTLP_ENDPOINT` (необязательная, пусто → `null`), `LOG_LEVEL` (`LogLevel`, по умолчанию `info`), `TELEMETRY_FLUSH_TIMEOUT_MS` (по умолчанию `2000`).
- `ApiConfig` — база + `API_PORT`, `ORCHESTRATOR_URL`, `MAX_ACTIVE_SWARMS` (спека 001).
- `OrchestratorConfig` — база + `ORCHESTRATOR_PORT`, `AGENT_TEMPLATE`, `DOCKER_AGENT_NETWORK`, `DOCKER_AGENT_NATS_URL`, `DOCKER_AGENT_OTLP_ENDPOINT` (необязательная, пусто → `null`), `AGENT_STEP_DELAY_MS`, `AGENT_START_TIMEOUT_MS`, `SWARM_TIMEOUT_MS`.
- `AgentConfig` — без `DATABASE_URL`: `NATS_URL`, `SWARM_ID`, `AGENT_ID`, `AGENT_NAME`, `AGENT_ROLE`, `AGENT_NEXT` (пусто → `null`), `AGENT_STEP_DELAY_MS`; телеметрия: `TRACEPARENT` и `OTEL_EXPORTER_OTLP_ENDPOINT` (пусто → `null`), `TELEMETRY_FLUSH_TIMEOUT_MS` (по умолчанию `2000`).
- `UiConfig` — `UI_PORT`; `ObservabilityConfig` — `GRAFANA_PORT`. Обе только для `infra:check`.

## Ограничения

- Не используется ядрами.
- Значения по умолчанию есть только у переменных телеметрии (016, 4.11); остальное отсутствующее — ошибка запуска.

## Связи

- Используют: оболочки `apps/api`, `apps/orchestrator`, `apps/agent`, `scripts/infra-check.ts`.
- Использует: `zod`, `@swag/contracts` (`LogLevel`).

## Ключевые решения

- `AGENT_NEXT=''` в env превращается в `null` (последний агент) через `transform`, а не отдельным флагом (4.7.1).
- `UiConfig` (только `UI_PORT`) добавлен для `infra:check`; сам UI env не читает.
- Лимиты и таймауты — env, без значений по умолчанию: отсутствие переменной — ошибка запуска (Q-3, REQ-000-9).
- Адреса телеметрии (`OTEL_EXPORTER_OTLP_ENDPOINT`, `DOCKER_AGENT_OTLP_ENDPOINT`) — общий тип: не задан или пустая строка — `null`, иначе URL. Пустое значение — штатный режим «только stdout» (REQ-016-6). `DOCKER_AGENT_OTLP_ENDPOINT` необязательна по той же логике (трактовка, D-18).
- `LOG_LEVEL` — та же схема `LogLevel`, что и поле `level` в `LogRecord` (`@swag/contracts`): уровни логгера и записи не расходятся.
- Оболочки разбирают переменные телеметрии отдельно (`BaseConfig.pick`, `AgentConfig.pick`) до полной конфигурации: так и ошибка конфигурации уходит логом `LogRecord`.

## Спеки

- 000 — `BaseConfig`, `loadConfig`.
- 001 — 4.9, переменные окружения.
- 016 — 4.11, переменные телеметрии.
