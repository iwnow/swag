# @swag/contracts

Общие схемы Zod и типы, которыми обмениваются сервисы и ядра: запрос на рой, рой, агент, запуск роя, сообщение шины, события платформы, subjects NATS, `ServiceInfo`, `traceId`, схема структурного лога и контракты LLM Gateway (каталог моделей, использование токенов, ошибки, вызывающий, деньги и списания, регистрация роя).

## Задачи

- Единые контракты из [спеки 001, раздел 4](../../docs/spec/001-walking-skeleton.md#4-контракты): `swarm.ts` (4.1), `bus.ts` (4.2), `events.ts` (4.3).
- Контракты наблюдаемости из [спеки 016](../../docs/spec/016-observability.md#4-контракты): `traceId` в конверте события (4.1), `LogRecord` (4.2).
- Контракты LLM Gateway из [спеки 002, раздел 4.1](../../docs/spec/002-llm-gateway.md#41-packagescontractssrcllmts-и-изменения-существующих-схем): `llm.ts`; событие `llm.call` в `events.ts`, источник и сервис `llm-gateway`.
- Типы выводятся из схем (`z.infer`), отдельно их не пишут.

## Что внутри сейчас

- `swarm.ts` — `AgentId`, `SwarmId`, `AgentDraft` (с `model: PlatformModel`, по умолчанию `chat-small`, и `budgetMicroUsd`, по умолчанию `null`), `SwarmCreateRequest` (с обязательным `budgetMicroUsd`), `AgentSpec`, `ENTRY_AGENT_ID`, `SwarmStatus`, `AgentStatus`, `SwarmLaunch` (с `budgetMicroUsd`), `SwarmSummary`, `LlmCaller`, `LlmSwarmRegistration` и `LlmSwarmClosed` (регистрация роя в gateway и ответ закрытия).
- `bus.ts` — `BusMessage`, subjects `inboxSubject`, `eventsSubject`, `ALL_INBOXES`, `ALL_EVENTS`.
- `events.ts` — `TraceId`, `PlatformEventInput` (дискриминированное объединение по `type`, в конверте `traceId: TraceId | null`; вариант `llm.call` с `LlmCallData`, источник `llm-gateway`; `agent.step`, `agent.idle`; `swarm.created` с необязательными бюджетами, у событий до 004 их нет; причины `agent_failed`, `api_restarted`, `budget_exceeded` и `gateway_unavailable` в `swarm.failed`), `PlatformEvent` (с `seq`).
- `log.ts` — `LogLevel`, `ServiceName` (с `llm-gateway`), `LogError`, `LogRecord`.
- `service-info.ts` — `ServiceInfo` (`service` с `llm-gateway`).
- `llm.ts` — `ModelId`, `PricePerMTok`, `ModelPrices`, `CatalogModel` (с `openRouterModel`), `ModelCatalog` (`models.json`), `MicroUsd`, `BudgetMicroUsd` (1…1_000_000_000), `LlmUsage`, `GatewayErrorCode` (с кодами 403 и 402 из 004), `ChargeBasis`, `LlmCharge`, `LlmCallStatus`, `LlmCallData` (с `charge`, необязательным), `PlatformModel` (`chat-small`, `chat-large`), заголовки `SWARM_ID_HEADER`, `AGENT_ID_HEADER`.

## Ограничения

- Схемы и типы, а также чистые правила над ними. Логики предметной области здесь нет, кроме проверок формы.
- Зависимости — только `zod`. Правила ядра проверяет `arch:check` (REQ-001-15, N-3).
- Лимиты длин полей (`max(4000)`, `max(500)`, `max(40)`, `max(8)`) — предложение, утверждено в Q-3.

## Связи

- Используют: все ядра (`api-core`, `orchestrator-core`, `agent-core`), `api-integration`, `ui-core`, адаптеры (`adapter-telemetry` — `LogRecord`, `LogLevel`, `ServiceName`) и оболочки.

## Ключевые решения

- Схемы zod 4 (`z.uuid()`, `z.iso.datetime()`, `z.strictObject`) — лишнее поле в запросе отклоняется (AC-001-1, AC-001-12).
- `PlatformEvent` = `PlatformEventInput & { seq }`: `seq` не входит в публикуемый контракт (4.3).
- `traceId` в конверте обязателен, но допускает `null` (016, 4.1): событие без контекста не отбрасывается, а отсутствие поля — ошибка схемы.
- `LogRecord` — `z.looseObject`: Fastify добавляет `req`, `res`, `responseTime`; `err` — строгий `LogError`, поэтому лишние поля ошибки (например, `code`) адаптер логгера отбрасывает.
- Отклонение от 4.1: `SwarmSummary` добавлен в `swarm.ts` (нужен и `api`, и `ui`), не в отдельный файл.
- LLM: цены в `ModelPrices` — десятичные строки до 4 знаков после точки, не больше 10000 USD за 1 млн токенов; `ModelId` — `^[a-z][a-z0-9-]{1,39}$`, `ModelCatalog` требует уникальные `id` (спека 002, 4.1).
- LLM: `usage` и `costMicroUsd` в `LlmCallData` — `null`, если провайдер не прислал usage или поток оборван до него; `costMicroUsd` задан тогда и только тогда, когда задан `usage` (по комментарию в схеме, схема этого не проверяет).
- LLM: `providerCostMicroUsd` — фактическая стоимость у провайдера для счёта платформы (D-38); на `costMicroUsd` не влияет.
- LLM: заголовки `x-swag-swarm-id` и `x-swag-agent-id` — до спеки 004 агент называет себя сам (Q-3).
- Деньги (004, 4.1): суммы — целые micro-USD (`MicroUsd`), бюджет — `BudgetMicroUsd` от 1 до 1_000_000_000 (верхняя граница контракта, рабочий предел — `SWARM_MAX_BUDGET_MICRO_USD`). Бюджет роя в `SwarmCreateRequest` обязателен (Q-5), бюджет агента `null` — только бюджет роя.
- Деньги: `LlmCharge` — то же, что запись ledger; `charge` в `LlmCallData` необязателен, потому что события до 004 его не несут. `costMicroUsd` остаётся стоимостью по `usage`.
- Регистрация роя: `LlmSwarmRegistration` и `LlmSwarmClosed` лежат в `swarm.ts`, а не в `llm.ts` по 004, 4.1: `llm.ts` не должен импортировать `swarm.ts` (цикл из-за `AgentId` и `SwarmId`). Это отклонение от буквы 4.1, которое принято при реализации T-1 — тот же приём, что у `LlmCaller`.
- 022: `PlatformModel` в `llm.ts`; `model` агента и `ENTRY_AGENT_ID` в `swarm.ts`; `agent.step`, `agent.idle` и причина `agent_failed` (4.1). `LlmCaller` переехал из `llm.ts` в `swarm.ts`: `swarm.ts` импортирует `PlatformModel` из `llm.ts`, обратный импорт `llm.ts` → `swarm.ts` дал бы цикл модулей.

## Спеки

- 000 — `ServiceInfo`.
- 001 — разделы 4.1–4.3.
- 002 — раздел 4.1 (`llm.ts`, `LlmCaller` в `swarm.ts`).
- 022 — раздел 4.1 (T-1).
- 004 — раздел 4.1 (T-1): бюджеты, `charge`, коды ошибок, регистрация роя; `LlmSwarmRegistration` в `swarm.ts`.
- 016 — разделы 4.1, 4.2.
- 003 — раздел 4.1: причина `api_restarted` в `swarm.failed` (T-1).
