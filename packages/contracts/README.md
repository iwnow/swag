# @swag/contracts

Общие схемы Zod и типы, которыми обмениваются сервисы и ядра: запрос на рой, рой, агент, запуск роя, сообщение шины, события платформы, subjects NATS, `ServiceInfo`, `traceId`, схема структурного лога, контракты LLM Gateway (каталог моделей, использование токенов, ошибки, вызывающий, деньги и списания, регистрация роя) и контракты identity (регистрация, вход, токены, коды ошибок), права и вызывающий (`Actor`, `Permission`, `can`), управление пользователями (приглашения, список, смена роли и блокировка, отзывы токенов) и баланс организации (пополнение, журнал, остаток).

## Задачи

- Единые контракты из [спеки 001, раздел 4](../../docs/spec/001-walking-skeleton.md#4-контракты): `swarm.ts` (4.1), `bus.ts` (4.2), `events.ts` (4.3).
- Контракты наблюдаемости из [спеки 016](../../docs/spec/016-observability.md#4-контракты): `traceId` в конверте события (4.1), `LogRecord` (4.2).
- Права и вызывающий из [спеки 024, раздел 4.1](../../docs/spec/024-organizations-access.md#41-swagcontracts-файл-srcaccessts): `access.ts` — `Permission`, `ROLE_PERMISSIONS`, `Actor`, `actorFromClaims`, `can`.
- Баланс организации из [спеки 013, раздел 4.1](../../docs/spec/013-balance.md#41-swagcontracts): `billing.ts`; права `balance.read` и `balance.topup` в `access.ts`; `spentMicroUsd` в итоговых событиях роя и `heldMicroUsd` в `LlmSwarmClosed`.
- Управление пользователями из [спеки 024, раздел 4.2](../../docs/spec/024-organizations-access.md#42-swagcontracts-дополнения-srcauthts): дополнения `auth.ts` — коды `forbidden`, `not_found`, `user_blocked`, `OrgRole`, `ManagedUser`, `UserList`, `InvitationRequest`, `InvitationAcceptRequest`, `UserUpdate`, `OrganizationSummary`, `OrganizationList`, `TokenRevocation`, `TokenRevocationList`.
- Контракты identity из [спеки 012, раздел 4.1](../../docs/spec/012-identity-signup-login.md#41-swagcontracts-файл-srcauthts): `auth.ts` — `UserId`, `OrgId`, `Role`, `Email`, `Password`, `OrganizationName`, запросы регистрации, подтверждения и входа, `AccessTokenClaims`, `AuthSession`, `AuthRefreshed`, `AuthMe`, `AuthErrorCode`.
- Контракты LLM Gateway из [спеки 002, раздел 4.1](../../docs/spec/002-llm-gateway.md#41-packagescontractssrcllmts-и-изменения-существующих-схем): `llm.ts`; событие `llm.call` в `events.ts`, источник и сервис `llm-gateway`.
- Типы выводятся из схем (`z.infer`), отдельно их не пишут.

## Что внутри сейчас

- `swarm.ts` — `AgentId`, `SwarmId`, `AgentDraft` (с `model: PlatformModel`, по умолчанию `chat-small`, и `budgetMicroUsd` и `maxTokens`, по умолчанию `null`), `SwarmCreateRequest` (с обязательным `budgetMicroUsd` и `maxTokens`, по умолчанию `null`), `AgentSpec`, `ENTRY_AGENT_ID`, `SwarmStatus`, `AgentStatus`, `SwarmLaunch` (с `budgetMicroUsd` и `maxTokens`, `null` допустим), `SwarmSummary`, `LlmCaller`, `LlmSwarmRegistration` и `LlmSwarmClosed` (ответ закрытия роя: `spentMicroUsd` и `heldMicroUsd`; `heldMicroUsd` пока всегда `0`, пока gateway не ждёт идущие вызовы — 013, T-5).
- `bus.ts` — `BusMessage`, subjects `inboxSubject`, `eventsSubject`, `ALL_INBOXES`, `ALL_EVENTS`.
- `events.ts` — `TraceId`, `PlatformEventInput` (дискриминированное объединение по `type`, в конверте `traceId: TraceId | null`; вариант `llm.call` с `LlmCallData`, источник `llm-gateway`; `agent.step`, `agent.idle`; `swarm.created` с необязательными бюджетами и `maxTokens` роя и агентов, `orgId` и `createdBy` (024, 4.3), у событий до 004 и 031 их нет; причины `agent_failed`, `api_restarted`, `budget_exceeded` и `gateway_unavailable` в `swarm.failed`), `PlatformEvent` (с `seq`).
- `auth.ts` — схемы identity (012, 4.1). `Email` — `trim`, нижний регистр, не больше 254 символов; `Password` — от 10 до 128 символов без `trim` (Q-10); `OrganizationName` — от 1 до 200 символов после `trim`; `AccessTokenClaims` — `iss: swag-identity`, `aud: swag`, `org` — `null` у supervisor.
- `access.ts` — `Permission` (`swarm.create`, `swarm.read`, `swarm.stop`, `user.manage`, `organization.read`, `balance.read`, `balance.topup`), `ROLE_PERMISSIONS` (таблица роль → права), `Actor` (`userId`, `orgId`, `role`, `permissions`), `actorFromClaims` (из `AccessTokenClaims`: `sub`, `org`, `role`), `can`.
- `billing.ts` — `TopupMicroUsd` (целое 1…1 000 000 000), `TopupRequest` (`comment` по умолчанию `null`, пустая строка не проходит), `BalanceView`, `BalanceEntryKind` (`topup`, `swarm`), `BalanceEntry`, `BalanceEntryList` (с `nextBefore`).
- `auth.ts` — дополнения 024: `OrgRole` (`user`, `admin`), `ManagedUser`, `UserList`, `InvitationRequest`, `InvitationAcceptRequest`, `UserUpdate` (хотя бы одно поле), `OrganizationSummary`, `OrganizationList`, `TokenRevocation`, `TokenRevocationList`.
- `log.ts` — `LogLevel`, `ServiceName` (с `llm-gateway` и `identity`), `LogError`, `LogRecord`.
- `service-info.ts` — `ServiceInfo` (`service` с `llm-gateway` и `identity`).
- `llm.ts` — `ModelId`, `PricePerMTok`, `ModelPrices`, `CatalogModel` (с `openRouterModel`), `ModelCatalog` (`models.json`), `MicroUsd`, `BudgetMicroUsd` (1…1_000_000_000), `MaxTokens` (целое 1…1_000_000, лимит ответа агента, 031), `LlmUsage`, `GatewayErrorCode` (с кодами 403 и 402 из 004), `ChargeBasis`, `LlmCharge`, `LlmCallStatus`, `LlmCallData` (с `charge`, необязательным), `PlatformModel` (`chat-small`, `chat-large`), заголовки `SWARM_ID_HEADER`, `AGENT_ID_HEADER`. `LlmSwarmRegistration` и `LlmSwarmClosed` намеренно лежат в `swarm.ts`, а не здесь: `swarm.ts` импортирует `llm.ts`, обратный импорт дал бы цикл.

## Ограничения

- Схемы и типы, а также чистые правила над ними. Логики предметной области здесь нет, кроме проверок формы.
- Зависимости — только `zod`. Правила ядра проверяет `arch:check` (REQ-001-15, N-3).
- Лимиты длин полей (`max(4000)`, `max(500)`, `max(40)`, `max(8)`) — предложение, утверждено в Q-3.

## Связи

- Используют: все ядра (`api-core`, `orchestrator-core`, `agent-core`), `api-integration`, `ui-core`, адаптеры (`adapter-telemetry` — `LogRecord`, `LogLevel`, `ServiceName`) и оболочки.

## Ключевые решения

- Права (024, 4.1): `actorFromClaims` берёт права из `ROLE_PERMISSIONS`, отдельного хранения прав в токене нет. Роль супервизора не создаёт роёв (Q-4): у неё нет `swarm.create`.
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
- Баланс (013, 4.1): `billing.ts` импортирует `auth.ts`, `llm.ts` и `swarm.ts`; обратного импорта нет, цикла нет. `spentMicroUsd` в `swarm.completed`, `swarm.stopped` и `swarm.failed` необязательно: события до 013 и события, которые записал `api` без ответа gateway, его не несут.
- Деньги: `LlmCharge` — то же, что запись ledger; `charge` в `LlmCallData` необязателен, потому что события до 004 его не несут. `costMicroUsd` остаётся стоимостью по `usage`.
- Регистрация роя: `LlmSwarmRegistration` и `LlmSwarmClosed` лежат в `swarm.ts`, а не в `llm.ts` по 004, 4.1: `llm.ts` не должен импортировать `swarm.ts` (цикл из-за `AgentId` и `SwarmId`). Это отклонение от буквы 4.1, которое принято при реализации T-1 — тот же приём, что у `LlmCaller`.
- 022: `PlatformModel` в `llm.ts`; `model` агента и `ENTRY_AGENT_ID` в `swarm.ts`; `agent.step`, `agent.idle` и причина `agent_failed` (4.1). `LlmCaller` переехал из `llm.ts` в `swarm.ts`: `swarm.ts` импортирует `PlatformModel` из `llm.ts`, обратный импорт `llm.ts` → `swarm.ts` дал бы цикл модулей.

## Спеки

- 013 — раздел 4.1 (`billing.ts`, права, `spentMicroUsd`, `LlmSwarmClosed`), T-1.
- 024 — раздел 4.1 (`access.ts`), раздел 4.2 (дополнения `auth.ts`), T-1.
- 000 — `ServiceInfo`.
- 012 — раздел 4.1 (`auth.ts`).
- 001 — разделы 4.1–4.3.
- 002 — раздел 4.1 (`llm.ts`, `LlmCaller` в `swarm.ts`).
- 022 — раздел 4.1 (T-1).
- 031 — раздел 4.1 (T-1): `MaxTokens`, `maxTokens` в `AgentDraft`, `SwarmCreateRequest`, `SwarmLaunch`, `swarm.created`.
- 004 — раздел 4.1 (T-1): бюджеты, `charge`, коды ошибок, регистрация роя; `LlmSwarmRegistration` в `swarm.ts`.
- 016 — разделы 4.1, 4.2.
- 003 — раздел 4.1: причина `api_restarted` в `swarm.failed` (T-1).
