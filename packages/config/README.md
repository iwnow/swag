# @swag/config

Чтение env и проверка Zod-схемами (спека 000, REQ-000-9). Только для оболочек: ядра получают уже проверенные значения аргументами.

## Задачи

- `loadConfig(schema, env)` — разобрать env; ошибка — `ConfigError` с именем переменной.
- Схемы сервисов: `BaseConfig`, `ApiConfig`, `OrchestratorConfig`, `AgentConfig`, `LlmGatewayConfig`, `IdentityConfig`, `UiConfig`, `ObservabilityConfig`.

## Что внутри сейчас

- `BaseConfig` — `DATABASE_URL`, `NATS_URL`; телеметрия (спека 016, 4.11): `OTEL_EXPORTER_OTLP_ENDPOINT` (необязательная, пусто → `null`), `LOG_LEVEL` (`LogLevel`, по умолчанию `info`), `TELEMETRY_FLUSH_TIMEOUT_MS` (по умолчанию `2000`).
- `ApiConfig` — база + `API_PORT`, `ORCHESTRATOR_URL`, `MAX_ACTIVE_SWARMS` (спека 001), `SWARM_MAX_BUDGET_MICRO_USD` (спека 004, 4.11: целое не меньше 1, без значения по умолчанию), `AGENT_MAX_TOKENS_LIMIT` (спека 031, 4.2: целое не меньше 1, предел `maxTokens` роя и агента), `BALANCE_MAX_TOPUP_MICRO_USD` (спека 013, 4.10: целое 1…1 000 000 000, по умолчанию `100000000`); спека 024, 4.14: `IDENTITY_URL` (URL), `IDENTITY_INTERNAL_TOKEN` (от 32 символов), `IDENTITY_JWT_PUBLIC_KEY` (непустая строка, base64 от SPKI PEM), `IDENTITY_JWT_KID`, `ORCHESTRATOR_TOKEN` (от 32 символов), `API_REVOCATION_POLL_MS` (≥ 1000, по умолчанию `5000`), `API_REVOCATION_MAX_STALE_MS` (≥ 1000, `30000`).
- `OrchestratorConfig` — база + `ORCHESTRATOR_PORT`, `AGENT_TEMPLATE`, `DOCKER_AGENT_NETWORK`, `DOCKER_AGENT_NATS_URL`, `DOCKER_AGENT_OTLP_ENDPOINT` (необязательная, пусто → `null`), `AGENT_START_TIMEOUT_MS`, `SWARM_TIMEOUT_MS`; спека 022, 4.8: `AGENT_MAX_STEPS`, `AGENT_MAX_TOKENS` (целые ≥ 1), `LLM_GATEWAY_TOKEN` (от 32 символов), `DOCKER_AGENT_LLM_GATEWAY_URL` (URL); спека 024, 4.13: `ORCHESTRATOR_TOKEN` (от 32 символов); спека 004, 4.11: `LLM_GATEWAY_URL` (URL, адрес gateway без `/v1` — внутренний API для регистрации роёв; в отличие от `AgentConfig.LLM_GATEWAY_URL` с `/v1`).
- `AgentConfig` — без `DATABASE_URL` (спека 022, 4.8): `NATS_URL`, `SWARM_ID`, `AGENT_ID`, `AGENT_NAME`, `AGENT_ROLE`, `AGENT_MODEL`, `AGENT_PEERS` (JSON-массив `{id, name, role}`), `AGENT_ENTRY`, `AGENT_MAX_STEPS`, `AGENT_MAX_TOKENS`, `LLM_GATEWAY_URL`, `LLM_GATEWAY_TOKEN` (от 32 символов), `AGENT_LLM_TIMEOUT_MS` (по умолчанию `120000`), `AGENT_LLM_MAX_RETRIES` (по умолчанию `2`); телеметрия: `TRACEPARENT` и `OTEL_EXPORTER_OTLP_ENDPOINT` (пусто → `null`), `TELEMETRY_FLUSH_TIMEOUT_MS` (по умолчанию `2000`).
- `LlmGatewayConfig` — телеметрия (`OTEL_EXPORTER_OTLP_ENDPOINT`, `LOG_LEVEL`, `TELEMETRY_FLUSH_TIMEOUT_MS`) и `NATS_URL`, `LLM_GATEWAY_PORT`, `LLM_GATEWAY_TOKEN` (от 32 символов), `LLM_CATALOG_PATH`, `LITELLM_URL`, `LITELLM_MASTER_KEY` (с `sk-`, от 16 символов), `LLM_PROFILE` (`test`, `dev`, `test-pay`, `prod`; спека 032, 4.1), таймауты и лимит тела `LLM_GATEWAY_UPSTREAM_TIMEOUT_MS`, `LLM_GATEWAY_STARTUP_TIMEOUT_MS`, `LLM_GATEWAY_BODY_LIMIT_BYTES` (спека 002, 4.9), `LLM_GATEWAY_CLOSE_WAIT_MS` (целое 0…8000, по умолчанию 5000; спека 013, 4.10); без `DATABASE_URL`.
- `IdentityConfig` (спека 012, 4.10) — `DATABASE_URL`, телеметрия (`OTEL_EXPORTER_OTLP_ENDPOINT`, `LOG_LEVEL`, `TELEMETRY_FLUSH_TIMEOUT_MS`), `IDENTITY_PORT`, `IDENTITY_CONFIRM_URL` (URL), `IDENTITY_JWT_PRIVATE_KEY` (непустая строка, ключ Ed25519 в base64 PKCS8), `IDENTITY_JWT_KID`, сроки `IDENTITY_ACCESS_TTL_S` (≥ 60, по умолчанию `900`), `IDENTITY_REFRESH_TTL_S` (≥ 3600, `2592000`), `IDENTITY_CONFIRM_TTL_S` (≥ 600, `86400`), `IDENTITY_COOKIE_SECURE` (`true`/`false`), `IDENTITY_BODY_LIMIT_BYTES` (≥ 1024, `16384`); спека 024, 4.14: `IDENTITY_INTERNAL_TOKEN` (от 32 символов), `IDENTITY_INVITE_URL` (URL), `IDENTITY_INVITE_TTL_S` (≥ 600, `604800`); `IDENTITY_SUPERVISOR_EMAIL` и `IDENTITY_SUPERVISOR_PASSWORD` необязательны, пустая строка — не задано, задан ровно один — ошибка (`superRefine`); почта `SMTP_URL` (URL), `SMTP_TIMEOUT_MS` (по умолчанию `10000`), `MAIL_FROM`.
- `UiConfig` — `UI_PORT`; спека 014, 4.10: `UI_CABINET_PORT` (по умолчанию `4201`), `UI_ADMIN_PORT` (`4202`), `UI_SUPERVISOR_PORT` (`4203`); `ObservabilityConfig` — `GRAFANA_PORT` и `TELEMETRY_RETENTION` (спека 003, 4.7: `<целое>h`, не меньше `24h`, значения по умолчанию нет). Обе для `infra:check`; `UiConfig` и `GRAFANA_PORT` читает ещё `ui:dev`.

## Ограничения

- Не используется ядрами.
- Значения по умолчанию есть у переменных телеметрии (016, 4.11), у трёх переменных `LLM_GATEWAY_*` (002, 4.9) и у `AGENT_LLM_TIMEOUT_MS`, `AGENT_LLM_MAX_RETRIES` (022, 4.8); остальное отсутствующее — ошибка запуска.
- `LlmGatewayConfig` не проверяет `.env.llm` отдельно: оболочка получает оба файла через `env_file` (002, 4.8), `.env.example` и `.env.llm.example` вместе проходят разбор (тест AC-002-27).

## Связи

- Используют: оболочки `apps/api`, `apps/orchestrator`, `apps/agent`, `scripts/infra-check.ts`; `apps/llm-gateway`; `apps/identity` (012, T-16).
- Использует: `zod`, `@swag/contracts` (`LogLevel`).

## Ключевые решения

- `AGENT_NEXT` и `AGENT_STEP_DELAY_MS` удалены (022, 4.8): `AgentConfig` и `OrchestratorConfig` их не знают, тест проверяет отсутствие ключей в результате.
- `AGENT_PEERS` разбирается `JSON.parse` внутри `transform`; ошибка JSON и элемент не по схеме дают ошибку с именем `AGENT_PEERS`. Схема `AgentPeer` продублирована здесь, а не импортирована из `agent-core`: конфиг зависит только от `@swag/contracts`.
- `ServiceToken` (от 32 символов) — общая схема всех внутренних токенов: `LLM_GATEWAY_TOKEN` в `OrchestratorConfig`, `AgentConfig` и `LlmGatewayConfig` (токен один на всех трёх концах: 022, 4.8; 002, 4.9), `ORCHESTRATOR_TOKEN` в `ApiConfig` и `OrchestratorConfig` (024, 4.13–4.14), `IDENTITY_INTERNAL_TOKEN` в `ApiConfig` и `IdentityConfig` (024, 4.14).
- Новые переменные доступа (024, 4.14) обязательны без значений по умолчанию, кроме двух лимитов отзывов и срока приглашения; `IDENTITY_JWT_PUBLIC_KEY` в `.env.example` пустой, поэтому `ApiConfig` с примером без ключа не проходит (тест AC-024-2).
- Трактовка 4.8: `AGENT_MAX_STEPS` и `AGENT_MAX_TOKENS` — целые ≥ 1 и в агенте, и в оркестраторе; `AGENT_LLM_MAX_RETRIES` ≥ 0, чтобы повторы можно было отключить.
- `UiConfig` (`UI_PORT` и порты трёх remote) добавлен для `infra:check` и `ui:dev`; сам UI env не читает.
- `TELEMETRY_RETENTION` проверяется регэкспом `^[1-9][0-9]*h$` и `refine` (≥ 24 часов): `12h`, `1d`, `24` отклоняются (спека 003, Q-5, тест AC-003-10). Значения по умолчанию нет, поэтому `infra:check` без строки в `.env` падает с ошибкой `TELEMETRY_RETENTION`; сервисы compose этот объект не читают.
- Лимиты и таймауты `ApiConfig`, `OrchestratorConfig`, `AgentConfig` — env без значений по умолчанию: отсутствие переменной — ошибка запуска (Q-3, REQ-000-9). Умолчания есть у телеметрии, трёх `LLM_GATEWAY_*` и двух `AGENT_LLM_*` (см. «Ограничения»).
- Адреса телеметрии (`OTEL_EXPORTER_OTLP_ENDPOINT`, `DOCKER_AGENT_OTLP_ENDPOINT`) — общий тип: не задан или пустая строка — `null`, иначе URL. Пустое значение — штатный режим «только stdout» (REQ-016-6). `DOCKER_AGENT_OTLP_ENDPOINT` необязательна по той же логике (трактовка, D-18).
- `LOG_LEVEL` — та же схема `LogLevel`, что и поле `level` в `LogRecord` (`@swag/contracts`): уровни логгера и записи не расходятся.
- Оболочки разбирают переменные телеметрии отдельно (`BaseConfig.pick`, `AgentConfig.pick`) до полной конфигурации: так и ошибка конфигурации уходит логом `LogRecord`.
- Ключи провайдеров (`OPENROUTER_API_KEY`) в `LlmGatewayConfig` не входят: их читает только адаптер через `secrets` (002, 4.9); `LITELLM_MASTER_KEY` входит, потому что нужен оболочке для вызова LiteLLM.
- `LLM_CATALOG_PATH` не входит в `.env.example`: по 4.8 его задаёт compose, а в 4.9 его нет. Тест AC-002-27 добавляет его сам, как compose (D-63).

## Спеки

- 000 — `BaseConfig`, `loadConfig`.
- 001 — 4.9, переменные окружения.
- 016 — 4.11, переменные телеметрии.
- 003 — 4.7, `TELEMETRY_RETENTION` (Q-5).
- 002 — 4.8 (файлы окружения), 4.9 (`LlmGatewayConfig`), AC-002-27.
- 022 — 4.8 (env агента и оркестратора, `.env.example`).
- 012 — 4.10 (`IdentityConfig`), 4.11 (переменные в `.env.example` и `.env`); ключ подписи в `.env.example` пустой, AC-012-2 без ключа — ошибка.
- 004 — 4.11, `SWARM_MAX_BUDGET_MICRO_USD` в `ApiConfig`.
- 031 — 4.2, `AGENT_MAX_TOKENS_LIMIT` в `ApiConfig`.
- 013 — 4.10, `BALANCE_MAX_TOPUP_MICRO_USD` в `ApiConfig`.
