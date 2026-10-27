# @swag/config

Чтение env и проверка Zod-схемами (спека 000, REQ-000-9). Только для оболочек: ядра получают уже проверенные значения аргументами.

## Задачи

- `loadConfig(schema, env)` — разобрать env; ошибка — `ConfigError` с именем переменной.
- Схемы сервисов: `BaseConfig`, `ApiConfig`, `OrchestratorConfig`, `AgentConfig`, `LlmGatewayConfig`, `UiConfig`, `ObservabilityConfig`.

## Что внутри сейчас

- `TelemetryConfig` (внутренняя, не экспортируется) — телеметрия (спека 016, 4.11): `OTEL_EXPORTER_OTLP_ENDPOINT` (необязательная, пусто → `null`), `LOG_LEVEL` (`LogLevel`, по умолчанию `info`), `TELEMETRY_FLUSH_TIMEOUT_MS` (по умолчанию `2000`). Входит в остальные схемы через `extend`.
- `BaseConfig` — `TelemetryConfig` + `DATABASE_URL`, `NATS_URL`.
- `ApiConfig` — база + `API_PORT`, `ORCHESTRATOR_URL`, `MAX_ACTIVE_SWARMS` (спека 001).
- `OrchestratorConfig` — база + `ORCHESTRATOR_PORT`, `AGENT_TEMPLATE`, `DOCKER_AGENT_NETWORK`, `DOCKER_AGENT_NATS_URL`, `DOCKER_AGENT_OTLP_ENDPOINT` (необязательная, пусто → `null`), `AGENT_STEP_DELAY_MS`, `AGENT_START_TIMEOUT_MS`, `SWARM_TIMEOUT_MS`.
- `AgentConfig` — без `DATABASE_URL`: `NATS_URL`, `SWARM_ID`, `AGENT_ID`, `AGENT_NAME`, `AGENT_ROLE`, `AGENT_NEXT` (пусто → `null`), `AGENT_STEP_DELAY_MS`; телеметрия: `TRACEPARENT` и `OTEL_EXPORTER_OTLP_ENDPOINT` (пусто → `null`), `TELEMETRY_FLUSH_TIMEOUT_MS` (по умолчанию `2000`).
- `LlmGatewayConfig` — телеметрия + `NATS_URL`, `LLM_GATEWAY_PORT`, `LLM_GATEWAY_TOKEN` (от 32 символов), `LLM_CATALOG_PATH`, `LITELLM_URL`, `LITELLM_MASTER_KEY` (с `sk-`, от 16 символов), таймауты и лимит тела `LLM_GATEWAY_UPSTREAM_TIMEOUT_MS`, `LLM_GATEWAY_STARTUP_TIMEOUT_MS`, `LLM_GATEWAY_BODY_LIMIT_BYTES` (спека 002, 4.9); без `DATABASE_URL`.
- `UiConfig` — `UI_PORT`; `ObservabilityConfig` — `GRAFANA_PORT`. Обе только для `infra:check`.

## Ограничения

- Не используется ядрами.
- Значения по умолчанию есть у переменных телеметрии (016, 4.11) и у трёх переменных `LLM_GATEWAY_*` (002, 4.9); остальное отсутствующее — ошибка запуска.
- `LlmGatewayConfig` не проверяет `.env.llm` отдельно: оболочка получает оба файла через `env_file` (002, 4.8), `.env.example` и `.env.llm.example` вместе проходят разбор (тест AC-002-27).

## Связи

- Используют: оболочки `apps/api`, `apps/orchestrator`, `apps/agent`, `scripts/infra-check.ts`; `apps/llm-gateway` (T-20).
- Использует: `zod`, `@swag/contracts` (`LogLevel`).

## Ключевые решения

- `AGENT_NEXT=''` в env превращается в `null` (последний агент) через `transform`, а не отдельным флагом (4.7.1).
- `UiConfig` (только `UI_PORT`) добавлен для `infra:check`; сам UI env не читает.
- Лимиты и таймауты — env, без значений по умолчанию: отсутствие переменной — ошибка запуска (Q-3, REQ-000-9).
- Адреса телеметрии (`OTEL_EXPORTER_OTLP_ENDPOINT`, `DOCKER_AGENT_OTLP_ENDPOINT`) — общий тип: не задан или пустая строка — `null`, иначе URL. Пустое значение — штатный режим «только stdout» (REQ-016-6). `DOCKER_AGENT_OTLP_ENDPOINT` необязательна по той же логике (трактовка, D-18).
- `LOG_LEVEL` — та же схема `LogLevel`, что и поле `level` в `LogRecord` (`@swag/contracts`): уровни логгера и записи не расходятся.
- Оболочки разбирают переменные телеметрии отдельно (`BaseConfig.pick`, `AgentConfig.pick`) до полной конфигурации: так и ошибка конфигурации уходит логом `LogRecord`.
- Общие поля телеметрии вынесены в `TelemetryConfig`, а не повторены в каждой схеме: порядок полей в `BaseConfig` и `AgentConfig` изменился, значения и проверки — прежние.
- Ключи провайдеров (`OPENROUTER_API_KEY`) в `LlmGatewayConfig` не входят: их читает только адаптер через `secrets` (002, 4.9); `LITELLM_MASTER_KEY` входит, потому что нужен оболочке для вызова LiteLLM.
- `LLM_CATALOG_PATH` не входит в `.env.example`: по 4.8 его задаёт compose, а в 4.9 его нет. Тест AC-002-27 добавляет его сам, как compose (D-63).

## Спеки

- 000 — `BaseConfig`, `loadConfig`.
- 001 — 4.9, переменные окружения.
- 016 — 4.11, переменные телеметрии.
- 002 — 4.8 (файлы окружения), 4.9 (`LlmGatewayConfig`), AC-002-27.
