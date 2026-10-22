# @swag/config

Чтение env и проверка Zod-схемами (спека 000, REQ-000-9). Только для оболочек: ядра получают уже проверенные значения аргументами.

## Задачи

- `loadConfig(schema, env)` — разобрать env; ошибка — `ConfigError` с именем переменной.
- Схемы сервисов: `BaseConfig`, `ApiConfig`, `OrchestratorConfig`, `AgentConfig`.

## Что внутри сейчас

- `BaseConfig` — `DATABASE_URL`, `NATS_URL`.
- `ApiConfig` — база + `API_PORT`, `ORCHESTRATOR_URL`, `MAX_ACTIVE_SWARMS` (спека 001).
- `OrchestratorConfig` — база + `ORCHESTRATOR_PORT`, `AGENT_TEMPLATE`, `DOCKER_AGENT_NETWORK`, `DOCKER_AGENT_NATS_URL`, `AGENT_STEP_DELAY_MS`, `AGENT_START_TIMEOUT_MS`, `SWARM_TIMEOUT_MS`.
- `AgentConfig` — без `DATABASE_URL`: `NATS_URL`, `SWARM_ID`, `AGENT_ID`, `AGENT_NAME`, `AGENT_ROLE`, `AGENT_NEXT` (пусто → `null`), `AGENT_STEP_DELAY_MS`.

## Ограничения

- Не используется ядрами.
- Значения по умолчанию не задаются: отсутствующая переменная — ошибка запуска.

## Связи

- Используют: оболочки `apps/api`, `apps/orchestrator`, `apps/agent`.
- Использует: `zod`.

## Ключевые решения

- `AGENT_NEXT=''` в env превращается в `null` (последний агент) через `transform`, а не отдельным флагом (4.7.1).
- `UiConfig` (только `UI_PORT`) добавлен для `infra:check`; сам UI env не читает.
- Лимиты и таймауты — env, без значений по умолчанию: отсутствие переменной — ошибка запуска (Q-3, REQ-000-9).

## Спеки

- 000 — `BaseConfig`, `loadConfig`.
- 001 — 4.9, переменные окружения.
