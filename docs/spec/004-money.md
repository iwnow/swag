---
id: "004"
title: Деньги роя
status: in-progress
roadmap_stage: 4
depends_on: ["002", "003", "022", "030"]
superseded_by: null
updated: 2026-10-30
---

# 004. Деньги роя

> **Коротко.** У роя появляется бюджет. Каждый вызов модели резервирует деньги до обращения к провайдеру, после ответа списывается по факту в ledger. Пользователь видит расход в реальном времени.
> - **Что появится.**
>   - **Бюджет роя и агента.** Бюджет роя в форме создания, у агента бюджет необязательный. Вызов, который может выйти за бюджет, gateway отклоняет `402` до обращения к LiteLLM. Рой падает с причиной `budget_exceeded`, песочницы убираются.
>   - **Регистрация роя в gateway.** Оркестратор при запуске роя передаёт gateway бюджеты роя и агентов и модели агентов, при завершении — закрывает рой. Вызов от незарегистрированного или закрытого роя, от агента не из регистрации или к чужой модели gateway отклоняет до LiteLLM. Агенты ходят с общим `LLM_GATEWAY_TOKEN` и заголовками `x-swag-*`, как в 002 (Q-2).
>   - **Резерв и списание.** До вызова gateway атомарно резервирует верхнюю оценку стоимости из бюджета роя и агента. После ответа резерв закрывается записью в ledger: стоимость по `usage`, а без `usage` — оценка. Параллельные вызовы не проходят сверх бюджета.
>   - **Ledger** — таблицы в Postgres через `adapter-postgres`. На вызов одна запись: тариф платформы и фактическая стоимость у провайдера.
>   - **Панель денег в UI.** По рою и агентам: потрачено из бюджета, остаток, расход за последнюю минуту. В ленте у вызова — списанная сумма, у оценки — пометка.
>   - **Сверка.** Команда `npm run money:report`: сколько списано по тарифу, сколько вызовы стоили у провайдера и разница. Ручная проверка ±1% к биллингу OpenRouter.
>   - **Цены из OpenRouter** (из N-9): gateway обновляет цены каталога при старте и раз в час. При сбое работает на последних ценах. Повторы запросов — общий хелпер `@swag/helpers` (из N-10).
> - **Ключевые решения (человек, 2026-10-30, все по рекомендациям):**
>   - ledger — одна запись на вызов, сумма всегда положительная, вид операции в поле `kind`; резервы — в отдельной таблице; двойная запись — в 013 (Q-1);
>   - рой и агента вызова gateway берёт из заголовков с общим токеном, как в 002, а бюджеты и модели агентов — из регистрации роя; ключа агента нет, пока недоверенный код не работает в песочнице агента (Q-2);
>   - верхняя оценка вызова — байты входа плюс `max_tokens`, поле `max_tokens` обязательно (Q-3);
>   - вызов без `usage` списывается по оценке, вызов с ошибкой — бесплатно (Q-4);
>   - бюджет роя обязателен, предел $5, в форме $0.50, бюджет агента необязательный (Q-5);
>   - сверка — с фактом провайдера и кредитами OpenRouter, без логов LiteLLM (Q-6);
>   - резервные провайдеры — отдельной спекой (Q-7);
>   - последние цены OpenRouter — в Postgres и переживают перезапуск, округление вверх до 4 знаков, экономия на кэше — клиенту, запись в кэш — не в 004 (Q-8).
> - **Меняет спеки:**
>   - 001 — тело `POST /swarms` и `swarm.created`;
>   - 002 — проверка вызывающего по регистрации, коды ошибок, каталог, строка `llm.call`, `llm:ping`;
>   - 022 — ограничение «`LLM_GATEWAY_TOKEN` в песочнице до 004» становится постоянным (Q-2).
>
>   Тексты этих спек правятся с пометкой «изменено спекой 004».
> - **Из бэклога:**
>   - D-5 → Q-1, D-37 → Q-8, D-38 → Q-1 и Q-6, D-39 → Q-7;
>   - N-9 → T-8, T-9; N-10 → T-2; N-14 → T-18.
> - **Что нужно от человека:**
>   - для ручной проверки AC-004-36 — ключ OpenRouter с кредитами на профиле `prod`; расход меньше $0.10.

## 1. Контекст и цель

Роадмап:
- этап 4 «Деньги»;
- [раздел 1 «LLM Gateway и LiteLLM»](../../AI_PLATFORM_ROADMAP.md#1-llm-gateway-и-litellm--единый-формат-и-учёт-денег): лимиты роя и агента в gateway, резерв до вызова, ledger, сверка;
- критерии MVP 4 «Деньги» и 5 «Бюджет».

**Сейчас:**
- gateway считает стоимость каждого вызова и публикует её в `llm.call` (002), но ничего не ограничивает;
- все агенты всех роёв ходят с одним `LLM_GATEWAY_TOKEN` и сами называют свой рой заголовками, gateway не знает, какие рои и агенты существуют;
- зациклившийся рой тратит деньги, пока не кончится `SWARM_TIMEOUT_MS`;
- суммы по рою нигде нет;
- цены каталога правятся руками.

**Цель:**
- у роя и агента есть бюджет, и gateway его не превышает даже при параллельных вызовах;
- вызвать модель от роя, который не запущен или уже завершён, от агента не из роя и к модели не из регистрации нельзя;
- каждый вызов оставляет запись в ledger, и её сумма сходится с событиями и с UI;
- фактическую стоимость у провайдера видно рядом с тарифом.

**Почему без ключа агента (Q-2).** Недоверенный код (скиллы, исполнение кода) никогда не работает в песочнице агентского цикла: для него — отдельная песочница без доступа к критичным данным. В песочнице агента только код платформы, поэтому общий токен в её env не открывает подмену роя. Если принцип нарушится, ключ агента возвращается отдельной спекой.

## 2. Объём

**Входит:**
- контракты: бюджеты в `SwarmCreateRequest`, `AgentDraft`, `SwarmLaunch` и `swarm.created`; регистрация роя в gateway; поле `charge` в `llm.call`; новые коды ошибок gateway; причины `budget_exceeded` и `gateway_unavailable`;
- `packages/helpers` (`@swag/helpers`): повтор с экспоненциальной задержкой (из N-10);
- `adapter-postgres`:
  - миграция `0002_money.sql`: бюджеты роёв и агентов, резервы, ledger, последние цены моделей;
  - хранилища `BudgetStore` и `PriceStore`;
  - отчёт сверки;
- `llm-gateway-core`:
  - внутренние операции `registerSwarm` и `closeSwarm`, проверка вызывающего по регистрации;
  - резерв до вызова и списание после него;
  - применение цен OpenRouter;
- `apps/llm-gateway`: внутренний API, Postgres и миграции при старте, освобождение висящих резервов, таймер цен;
- `packages/adapter-openrouter`: чтение цен моделей OpenRouter;
- `orchestrator-core` и новый `packages/adapter-gateway-http`: регистрация роя и закрытие, причина `budget_exceeded`;
- `api-core` и `api-integration`: бюджет в запросе и проверка лимита, деньги в проекции роя;
- `ui-core` и `cabinet`: бюджет в форме, панель денег, сумма в строке вызова;
- команда `npm run money:report`; `npm run llm:ping` через регистрацию;
- профиль `dev`: закреплённая модель `chat-small` (из N-14).

**Не входит** (агент это не делает, даже если кажется логичным):
- пользователи, организации, балансы, пополнения, резерв бюджета роя из баланса — 012, 024, 013;
- баланс ИИ и отказ сверх его остатка — 025 (D-27);
- стоимость compute (секунды песочницы × тариф) — 013, вместе с балансом;
- свой ключ организации к провайдеру и учёт вызовов на нём — D-35;
- ключ агента и смена env агента: `LLM_GATEWAY_TOKEN` и заголовки `x-swag-*` остаются, как в 002 и 022 (Q-2);
- двойная запись и счета платформы, поступления, маржа по организациям, остаток кредитов у провайдера — 013, 025 и 014 (D-38, Q-1);
- сверка с логами LiteLLM и дозапрос факта у OpenRouter — Q-6;
- резервные провайдеры и `fallbacks` в LiteLLM — D-39 (Q-7);
- история цен: в БД только последние успешные цены (Q-8);
- цена записи в кэш промпта и кэш ответов LiteLLM — D-37 (Q-8);
- лимит сообщений на ребро, `maxSteps` в плане — спека координатора 027;
- несколько экземпляров gateway: освобождение резервов при старте рассчитано на один процесс;
- повторная доставка `llm.call` при сбое шины — спека надёжности шины (N-11);
- остальные внешние адаптеры на `@swag/helpers` — по мере появления.

## 3. Требования

| ID | Требование | Приоритет |
|---|---|---|
| REQ-004-1 | `POST /swarms` MUST требовать бюджет роя `budgetMicroUsd` от 1 до `SWARM_MAX_BUDGET_MICRO_USD`. У агента бюджет MAY быть задан и MUST NOT превышать бюджет роя. Иначе `400 validation_error`. | MUST |
| REQ-004-2 | Бюджеты MUST попадать в `swarm.created` и в `SwarmLaunch` по 4.1. | MUST |
| REQ-004-3 | Оркестратор MUST зарегистрировать рой в gateway до создания песочниц: бюджет роя, срок регистрации и агенты с моделями и бюджетами. Регистрация не удалась — `swarm.failed` `gateway_unavailable`, песочницы не создаются. Env агента MUST NOT меняться: `LLM_GATEWAY_TOKEN` и заголовки `x-swag-*`, как в 022. | MUST |
| REQ-004-4 | Gateway MUST брать рой и агента вызова из заголовков `x-swag-swarm-id` и `x-swag-agent-id`, как в 002. Если рой не зарегистрирован, закрыт или срок его регистрации истёк, или агента нет в регистрации роя, ответ MUST быть `403 caller_not_registered` без обращения к LiteLLM. | MUST |
| REQ-004-5 | Если модель запроса не модель агента из регистрации, ответ MUST быть `403 model_not_allowed` без обращения к LiteLLM. | MUST |
| REQ-004-6 | Регистрация MUST отклоняться без записи в БД: тело не по схеме или бюджет агента больше бюджета роя — `400 invalid_request`, модели агента нет в каталоге — `400 model_not_found`, рой уже зарегистрирован — `409 swarm_registered`. Рой и его агенты пишутся одной транзакцией. | MUST |
| REQ-004-7 | Внутренний API `/internal/*` MUST требовать `LLM_GATEWAY_TOKEN`, как `/v1/*` в 002, иначе `401 unauthorized`. | MUST |
| REQ-004-8 | До обращения к LiteLLM gateway MUST атомарно зарезервировать верхнюю оценку вызова (4.3) из бюджета роя и, если он задан, из бюджета агента. Если `потрачено + в резерве + оценка` больше бюджета, ответ MUST быть `402` с кодом `swarm_budget_exceeded` или `agent_budget_exceeded`, без обращения к LiteLLM. | MUST |
| REQ-004-9 | При параллельных вызовах сумма резервов и трат MUST NOT превышать бюджет: лишние вызовы получают `402`. | MUST |
| REQ-004-10 | После вызова gateway MUST закрыть резерв и записать в ledger ровно одну запись на `callId` с суммой списания по правилам 4.3. Резерв, трата и запись меняются одной транзакцией. | MUST |
| REQ-004-11 | Событие `llm.call` MUST нести `charge`: ту же сумму и основание, что и запись ledger. | MUST |
| REQ-004-12 | Если фактическая стоимость больше резерва, gateway MUST списать фактическую и записать лог `warn` `hold_exceeded`. | MUST |
| REQ-004-13 | Ошибка записи списания MUST NOT менять ответ клиенту: событие публикуется, лог `error` `settle_failed`, резерв остаётся до перезапуска. | MUST |
| REQ-004-14 | При старте gateway MUST применить миграции и освободить резервы, оставшиеся от прошлого процесса, без списания: лог `warn` `hold_released` на каждый. | MUST |
| REQ-004-15 | Оркестратор MUST закрыть рой в gateway при любом итоге роя. После закрытия вызовы роя дают `403 caller_not_registered`. Регистрация MUST истекать сама через `SWARM_TIMEOUT_MS + 60 с` после запуска, даже если закрытие не дошло. | MUST |
| REQ-004-16 | Если агент упал с `model_error:swarm_budget_exceeded` или `model_error:agent_budget_exceeded`, оркестратор MUST завершить рой `swarm.failed` с причиной `budget_exceeded` и `detail` `<agentId>: <код>`. | MUST |
| REQ-004-17 | Проекция роя MUST считать бюджет и потрачено по рою и по каждому агенту из событий. UI MUST показывать в реальном времени: потрачено, бюджет, остаток, расход за последнюю минуту по рою и потрачено по агентам. | MUST |
| REQ-004-18 | После завершения роя сумма его записей ledger MUST совпадать с суммой `charge.microUsd` его событий `llm.call`, с `spentMicroUsd` проекции и с ответом закрытия роя. | MUST |
| REQ-004-19 | `npm run money:report` MUST печатать по рою или периоду: число вызовов, списано по тарифу, фактическую стоимость, вызовы без фактической стоимости и разницу. | MUST |
| REQ-004-20 | Gateway MUST обновлять цены каталога из OpenRouter при старте и каждые `LLM_PRICES_REFRESH_MS` по 4.9 и сохранять последние успешные цены в Postgres. При сбое — последние успешные цены, на старте до ответа OpenRouter — цены из Postgres, а для моделей без сохранённой цены — `models.json`. Профиль `test` MUST NOT обращаться к OpenRouter. | MUST |
| REQ-004-21 | Повторы запроса цен MUST идти через `retry` из `@swag/helpers` по 4.10. | MUST |
| REQ-004-22 | `npm run check` и CI MUST проходить без ключей провайдеров и без доступа к OpenRouter. | MUST |
| REQ-004-23 | Профиль `dev` SHOULD использовать закреплённую бесплатную модель `chat-small` с `tools`, на которой рои S-3 не падают по `max_tokens`. | SHOULD |

## 4. Контракты

### 4.1. Изменения `@swag/contracts`

`llm.ts`:

```ts
// Деньги — целые micro-USD. Верхняя граница бюджета роя в контракте; рабочий лимит — SWARM_MAX_BUDGET_MICRO_USD (4.11).
export const MicroUsd = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
export const BudgetMicroUsd = z.number().int().min(1).max(1_000_000_000); // до $1000

// Модель каталога: openRouterModel — id модели OpenRouter для обновления цен (4.9), только в профилях dev и prod.
export const CatalogModel = z.strictObject({
  id: ModelId,
  prices: ModelPrices,
  openRouterModel: z.string().min(1).optional(),
});

// GatewayErrorCode: добавить четыре кода.
export const GatewayErrorCode = z.enum([
  'unauthorized',
  'invalid_caller',
  'invalid_request',
  'model_not_found',
  'caller_not_registered', // 403: роя нет в регистрации, он закрыт или истёк; агента нет в регистрации
  'model_not_allowed', // 403: модель запроса не модель агента из регистрации
  'swarm_budget_exceeded', // 402
  'agent_budget_exceeded', // 402
  'upstream_bad_request',
  'rate_limited',
  'upstream_error',
  'upstream_timeout',
]);

// Списание вызова: то же, что запись ledger (4.3).
export const ChargeBasis = z.enum(['usage', 'estimate', 'none']);
export const LlmCharge = z.strictObject({ microUsd: MicroUsd, basis: ChargeBasis });

// LlmCallData: добавить поле.
//   charge: LlmCharge.optional(), // нет только у событий, записанных до спеки 004
// costMicroUsd остаётся стоимостью по usage (002, 4.3), charge — что списано.

// Регистрация роя в gateway: тело POST /internal/swarms.
export const LlmSwarmRegistration = z.strictObject({
  swarmId: SwarmId,
  budgetMicroUsd: BudgetMicroUsd,
  expiresAt: z.iso.datetime().nullable(), // null — регистрация не истекает сама (SWARM_TIMEOUT_MS = 0)
  agents: z
    .array(z.strictObject({ agentId: AgentId, model: ModelId, budgetMicroUsd: BudgetMicroUsd.nullable() }))
    .min(1)
    .max(8),
});
export const LlmSwarmClosed = z.strictObject({ spentMicroUsd: MicroUsd });
```

`SWARM_ID_HEADER`, `AGENT_ID_HEADER` и `LlmCaller` не меняются (002).

`swarm.ts`:

```ts
export const AgentDraft = z.strictObject({
  name: z.string().trim().min(1).max(40),
  role: z.string().trim().min(1).max(500),
  model: PlatformModel.default('chat-small'),
  budgetMicroUsd: BudgetMicroUsd.nullable().default(null), // null — только бюджет роя
});
export const SwarmCreateRequest = z.strictObject({
  task: z.string().trim().min(1).max(4000),
  budgetMicroUsd: BudgetMicroUsd,
  agents: z.array(AgentDraft).min(1).max(8),
});
export const SwarmLaunch = z.strictObject({
  swarmId: SwarmId,
  task: z.string(),
  budgetMicroUsd: BudgetMicroUsd,
  agents: z.array(AgentSpec).min(1),
});
```

`events.ts`:
- `swarm.created.data`: `{ task, budgetMicroUsd: BudgetMicroUsd.optional(), agents }`. У событий до 004 поля нет. `AgentSpec.budgetMicroUsd` у таких событий тоже нет: в схеме события агент — `AgentSpec.partial({ budgetMicroUsd: true })`.
- `swarm.failed.data.reason`: добавить `'budget_exceeded'` и `'gateway_unavailable'`.

### 4.2. Регистрация роя и внутренний API gateway

| Метод и путь | Токен | Тело | Ответ |
|---|---|---|---|
| `POST /internal/swarms` | `LLM_GATEWAY_TOKEN` | `LlmSwarmRegistration` | `204`; `409 swarm_registered`; `400 invalid_request` (тело не по схеме, бюджет агента больше бюджета роя); `400 model_not_found` (модели нет в каталоге) |
| `POST /internal/swarms/:swarmId/close` | `LLM_GATEWAY_TOKEN` | — | `200 LlmSwarmClosed`; повтор — тот же ответ; `404 not_found` |
| `GET /v1/models` | `LLM_GATEWAY_TOKEN` | — | как в 002 |
| `POST /v1/chat/completions` | `LLM_GATEWAY_TOKEN`, заголовки `x-swag-*` | как в 002 | как в 002, плюс коды 4.12 |

Токен на `/internal/*` проверяется в `onRequest` оболочки так же, как на `/v1/*` в 002 (`timingSafeEqual`).

Ошибки `/internal/*` — `{ error: { message, code } }`. Коды `swarm_registered` и `not_found` — `InternalErrorCode` в ядре, в `GatewayErrorCode` не входят.

Закрытие роя: `closed_at = now`, новые вызовы роя — `403 caller_not_registered`. Резервы вызовов, которые уже идут, закрываются как обычно. Ответ — `spent_micro_usd` роя после закрытия.

**Проверка вызывающего** — в ядре, после `LlmCaller` (002): `BudgetStore.findAgent(swarmId, agentId)`. Вызов отклоняется `403 caller_not_registered`, если записи нет, `closed` или `expiresAt` не позже `Clock.now`.

### 4.3. Резерв и списание

Цены `p_in`, `p_cached`, `p_out` — целые из 002, 4.3 (цена × 10⁴).

**Оценка входа.** `inputBytes` — длина в UTF-8 (`TextEncoder`) строки `JSON.stringify({ messages: body.messages, tools: body.tools ?? [] })`. Токен модели — не меньше байта, поэтому байты — верхняя граница токенов (Q-3).

**Резерв.**

```
maxOut      = body.max_tokens ?? body.max_completion_tokens   // нет обоих — 400 invalid_request "max_tokens is required"
holdMicroUsd = ceil((inputBytes·p_in + maxOut·p_out) / 10⁴)
```

Порядок `complete` (шаги 1–4 — как в 002):
1. Токен уже проверен оболочкой.
2. Заголовки — `LlmCaller`, иначе `400 invalid_caller`.
3. Тело — `ChatRequest`.
4. Модель есть в каталоге.
5. Рой и агент есть в регистрации, рой не закрыт и не истёк (4.2), иначе `403 caller_not_registered`.
6. Модель равна модели агента из регистрации, иначе `403 model_not_allowed`.
7. `max_tokens` — целое ≥ 1.
8. Резерв `BudgetStore.reserve`.
9. Вызов LiteLLM.

Отказ на шагах 2–8 — без события `llm.call`, лог `warn` с кодом. При `402` лог `budget_exceeded` с `swarmId`, `agentId`, `holdMicroUsd`.

**Списание после вызова.** Пишется один раз на `callId` перед публикацией события (у потока — в `finally` обёртки).

| Итог вызова | `charge.microUsd` | `basis` |
|---|---|---|
| `usage` есть (любой `status`) | `costMicroUsd(usage, prices)` | `usage` |
| `usage` нет, `status: 'ok'` или `'aborted'` | `ceil((inputBytes·p_in + outputBytes·p_out) / 10⁴)` | `estimate` |
| `status: 'error'` | 0 | `none` |

`outputBytes` — длина в UTF-8 всех `content` и `tool_calls[].function.arguments`:
- без потока — из `choices[].message`;
- в потоке — из `choices[].delta` всех фрагментов, которые дошли до клиента.

Примеры, они же тесты AC-004-9 (цены in / cached / out = 3.00 / 0.30 / 15.00):

| Случай | Ожидаемое |
|---|---|
| `inputBytes` 1000, `max_tokens` 500 | `holdMicroUsd` 10500 |
| `inputBytes` 1, `max_tokens` 1, цены 0 / 0 / 0 | `holdMicroUsd` 0 |
| `usage` 1000 / 200 / 500, `status: 'ok'` | 9960, `usage` |
| нет `usage`, `inputBytes` 1000, `outputBytes` 100, `status: 'aborted'` | 4500, `estimate` |
| нет `usage`, `status: 'ok'`, `inputBytes` 10, `outputBytes` 0 | 30, `estimate` |
| `status: 'error'` | 0, `none` |

Функции ядра — чистые, экспортируются:

```ts
export function inputBytes(body: ChatRequest): number;
export function holdMicroUsd(inputBytes: number, maxOut: number, prices: ModelPrices): number;
export function outputBytes(message: unknown): number; // один message или delta
export function chargeFor(
  call: { status: LlmCallStatus; usage: LlmUsage | null; inputBytes: number; outputBytes: number },
  prices: ModelPrices,
): LlmCharge;
```

### 4.4. Ядро `llm-gateway-core`: новые порты и операции

```ts
export interface RegisteredAgent { model: ModelId; expiresAt: Date | null; closed: boolean; }

export type ReserveResult = { ok: true } | { ok: false; code: 'swarm_budget_exceeded' | 'agent_budget_exceeded' };

export interface BudgetStore {
  // Рой и его агенты одной транзакцией; false — рой уже есть.
  register(reg: LlmSwarmRegistration, now: Date): Promise<boolean>;
  findAgent(swarmId: string, agentId: string): Promise<RegisteredAgent | null>;
  // Атомарно: held += amount у роя и (если бюджет задан) у агента — только если spent + held + amount ≤ budget.
  reserve(callId: string, caller: LlmCaller, amountMicroUsd: number, now: Date): Promise<ReserveResult>;
  // Одна транзакция: удалить резерв callId, held −= резерв, spent += charge, запись ledger.
  settle(entry: LedgerEntry): Promise<void>;
  close(swarmId: string, now: Date): Promise<{ spentMicroUsd: number } | null>; // null — роя нет
  releaseHolds(): Promise<{ callId: string; swarmId: string; amountMicroUsd: number }[]>;
}

export interface LedgerEntry {
  callId: string;
  ts: string;
  swarmId: string;
  agentId: string;
  model: ModelId;
  kind: 'llm';
  amountMicroUsd: number; // = charge.microUsd
  basis: ChargeBasis;
  providerCostMicroUsd: number | null;
}

export interface PriceBook {
  prices(model: ModelId): ModelPrices; // текущие цены (4.9)
}

// Последние успешные цены OpenRouter (4.9), ключ — openRouterModel.
export interface StoredPrice { openRouterModel: string; prices: ModelPrices; updatedAt: Date; }
export interface PriceStore {
  load(): Promise<StoredPrice[]>;
  save(prices: StoredPrice[]): Promise<void>; // upsert одной транзакцией
}

export interface LlmGatewayDeps {
  // …как в 002, плюс:
  budgets: BudgetStore;
  prices: PriceBook; // вместо цен из catalog; catalog остаётся источником списка моделей
}

export interface LlmGatewayCore {
  // …как в 002, сигнатура complete не меняется; плюс:
  registerSwarm(raw: unknown): Promise<InternalResult<void>>;
  closeSwarm(swarmId: string): Promise<InternalResult<LlmSwarmClosed>>;
  releaseHolds(): Promise<number>; // лог warn hold_released на каждый
}

export type InternalErrorCode = 'invalid_request' | 'model_not_found' | 'swarm_registered' | 'not_found';
export type InternalResult<T> =
  | { ok: true; value: T }
  | { ok: false; status: number; error: { message: string; code: InternalErrorCode } };
```

Если `settle` бросает, ядро пишет лог `error` `settle_failed` с `callId` и `err` и всё равно публикует событие с `charge` (REQ-004-13). Если `charge.microUsd > holdMicroUsd`, ядро пишет лог `warn` `hold_exceeded` с `callId`, `holdMicroUsd`, `chargeMicroUsd`. Лог `llm call` (002, 4.10) дополняется полями `chargeMicroUsd` и `chargeBasis`.

### 4.5. Таблицы: `packages/adapter-postgres/migrations/0002_money.sql`

```sql
-- Up Migration
create table swarm_budgets (
  swarm_id uuid primary key,
  budget_micro_usd bigint not null check (budget_micro_usd > 0),
  spent_micro_usd bigint not null default 0 check (spent_micro_usd >= 0),
  held_micro_usd bigint not null default 0 check (held_micro_usd >= 0),
  created_at timestamptz not null,
  expires_at timestamptz,
  closed_at timestamptz
);
create table swarm_agents (
  swarm_id uuid not null references swarm_budgets (swarm_id) on delete cascade,
  agent_id text not null,
  model text not null,
  budget_micro_usd bigint check (budget_micro_usd > 0),
  spent_micro_usd bigint not null default 0 check (spent_micro_usd >= 0),
  held_micro_usd bigint not null default 0 check (held_micro_usd >= 0),
  primary key (swarm_id, agent_id)
);
create table budget_holds (
  call_id uuid primary key,
  swarm_id uuid not null references swarm_budgets (swarm_id) on delete cascade,
  agent_id text not null,
  amount_micro_usd bigint not null check (amount_micro_usd >= 0),
  created_at timestamptz not null
);
create table ledger_entries (
  call_id uuid primary key,
  ts timestamptz not null,
  kind text not null check (kind in ('llm')),
  swarm_id uuid not null,
  agent_id text not null,
  model text not null,
  amount_micro_usd bigint not null check (amount_micro_usd >= 0),
  basis text not null check (basis in ('usage', 'estimate', 'none')),
  provider_cost_micro_usd bigint check (provider_cost_micro_usd >= 0)
);
create index ledger_entries_swarm_idx on ledger_entries (swarm_id);
create index ledger_entries_ts_idx on ledger_entries (ts);
create table model_prices (
  open_router_model text primary key,
  input_per_mtok_usd numeric(9, 4) not null check (input_per_mtok_usd >= 0),
  cached_input_per_mtok_usd numeric(9, 4) not null check (cached_input_per_mtok_usd >= 0),
  output_per_mtok_usd numeric(9, 4) not null check (output_per_mtok_usd >= 0),
  updated_at timestamptz not null
);
-- Down Migration
drop table model_prices;
drop table ledger_entries;
drop table budget_holds;
drop table swarm_agents;
drop table swarm_budgets;
```

У `ledger_entries` нет внешнего ключа на `swarm_budgets`: запись ledger живёт дольше бюджета. Таблицы роёв из 003 не меняются.

`model_prices` — последние успешные цены OpenRouter (Q-8). Ключ — id модели OpenRouter, а не модели платформы: у `chat-small` в `dev` и `prod` разные модели провайдера, а смена `openRouterModel` в `models.json` не подхватывает чужую сохранённую цену. Цена читается в строку `PricePerMTok` без незначащих нулей (`3.0000` → `"3"`), пишется из строки без `Number`.

**Резерв одной транзакцией** (`reserve`):

```sql
update swarm_budgets set held_micro_usd = held_micro_usd + $amt
 where swarm_id = $swarm and closed_at is null
   and spent_micro_usd + held_micro_usd + $amt <= budget_micro_usd
returning 1;                                   -- 0 строк → swarm_budget_exceeded, rollback
update swarm_agents set held_micro_usd = held_micro_usd + $amt
 where swarm_id = $swarm and agent_id = $agent
   and (budget_micro_usd is null or spent_micro_usd + held_micro_usd + $amt <= budget_micro_usd)
returning 1;                                   -- 0 строк → agent_budget_exceeded, rollback
insert into budget_holds (call_id, swarm_id, agent_id, amount_micro_usd, created_at) values (…);
```

Условный `update` берёт блокировку строки, поэтому параллельные резервы одного роя выстраиваются в очередь без `select … for update`.

**Списание** (`settle`): удалить `budget_holds` по `call_id` и вернуть `amount`. У роя и агента `held −= amount`, `spent += charge`. Затем `insert into ledger_entries … on conflict (call_id) do nothing`. Резерва нет (освобождён при старте) — трата и запись ledger всё равно пишутся, `held` не меняется.

**Поиск агента** (`findAgent`): `swarm_agents` по `(swarm_id, agent_id)` с `expires_at` и `closed_at is not null` роя из `swarm_budgets`.

**Освобождение при старте** (`releaseHolds`): все строки `budget_holds` удаляются, у их роёв и агентов `held` уменьшается на их суммы — одной транзакцией.

Фабрики: `createPostgresBudgetStore(pool: pg.Pool): BudgetStore`, `createPostgresPriceStore(pool: pg.Pool): PriceStore` (`save` — `insert … on conflict (open_router_model) do update`).

Отчёт для 4.10:

```ts
export interface LedgerReport {
  calls: number;
  chargedMicroUsd: number;
  byBasis: Record<ChargeBasis, { calls: number; microUsd: number }>;
  providerCostMicroUsd: number; // сумма по вызовам, где факт есть
  callsWithoutProviderCost: number;
  chargedWithProviderCostMicroUsd: number; // списано по тем же вызовам, где факт есть
}
export function ledgerReport(pool: pg.Pool, filter: { swarmId?: string; since?: Date }): Promise<LedgerReport>;
```

### 4.6. Оркестратор

Порт `orchestrator-core`:

```ts
export interface LlmSwarms {
  register(reg: LlmSwarmRegistration): Promise<void>; // ошибка — исключение
  close(swarmId: string): Promise<void>;
}
// OrchestratorCoreDeps: добавить llmSwarms: LlmSwarms.
```

- **`launch`.** После проверки `SwarmLaunch` и `swarm_exists` — `llmSwarms.register`:
  - `expiresAt = clock.now + timeouts.swarmMs + 60000`, при `swarmMs = 0` — `null`;
  - модели и бюджеты агентов — из `AgentSpec`.

  Исключение — `swarm.failed` `gateway_unavailable` с `detail` из сообщения ошибки, без песочниц. Env агента не меняется (022, 4.8).
- **`finish`.** После уборки песочниц и до итогового события — `llmSwarms.close(swarmId)`. Исключение — лог `warn` `gateway_close_failed`, рой всё равно завершается.
- **`handleEvent`, `agent.failed` в `running`.** `reason` — `model_error:swarm_budget_exceeded` или `model_error:agent_budget_exceeded` → итог `swarm.failed` с причиной `budget_exceeded`, `detail: "<agentId>: <код>"`. Остальные причины — как в 022.

Адаптер `packages/adapter-gateway-http`: `createGatewaySwarms({ baseUrl, token, timeoutMs }): LlmSwarms` на `fetch`:
- `register` → `POST /internal/swarms`; ответ не `204` — исключение с кодом из тела;
- `close` → `POST /internal/swarms/:id/close`; `404` — успех.

Повторов нет: рой с недоступным gateway падает сразу.

Агент (`AgentConfig`, `adapter-openai`, 022) не меняется: `402` и `403` gateway приходят к нему как ошибка модели с кодом из тела, `agent.failed` несёт `model_error:<код>` (022).

### 4.7. `api` и проекция роя

- `api-core.createSwarm`:
  - `budgetMicroUsd > limits.maxBudgetMicroUsd` → `validation_error` с сообщением `budget exceeds SWARM_MAX_BUDGET_MICRO_USD`;
  - бюджет агента больше бюджета роя → `validation_error` `agent budget exceeds swarm budget`;
  - бюджеты идут в `swarm.created` и `SwarmLaunch`.

  `ApiCoreDeps.limits` дополняется `maxBudgetMicroUsd`.
- `SwarmView` (`api-integration`):

  ```ts
  budgetMicroUsd?: number;  // нет у роёв до 004
  spentMicroUsd: number;    // сумма charge.microUsd событий llm.call роя (без charge — costMicroUsd ?? 0)
  agents: { …как в 001; budgetMicroUsd?: number | null; spentMicroUsd: number }[];
  ```

  `applyEvent`:
  - `swarm.created` задаёт бюджеты;
  - `llm.call` прибавляет сумму к рою и агенту события.

  Проекции, сохранённые в Postgres до 004, читаются без полей; `ui-core` показывает их как `—` и `$0.0000`.

### 4.8. UI

`ui-core`:

```ts
// Сумма в USD: microUsd / 1e6, ровно 4 знака после точки, округление вверх. 0 → "$0.0000".
export function formatUsd(microUsd: number): string;
// Сумма charge событий llm.call с ts в (nowMs − 60000, nowMs], micro-USD.
export function spentLastMinute(events: PlatformEvent[], nowMs: number): number;
// Строка панели роя.
export function formatSwarmMoney(view: SwarmView, lastMinuteMicroUsd: number): string;
```

| `view` | Строка `formatSwarmMoney` |
|---|---|
| бюджет 500000, потрачено 12345, за минуту 2100 | `$0.0124 из $0.5000 · остаток $0.4876 · $0.0021 за минуту` |
| бюджета нет (рой до 004), потрачено 0 | `$0.0000 · бюджет — · $0.0000 за минуту` |
| потрачено больше бюджета (`hold_exceeded`) | остаток `$0.0000` |

Остаток — `formatUsd(floor(max(0, бюджет − потрачено) / 100) · 100)`: округление вниз, чтобы остаток не завышался; 487655 → `$0.4876`.

`formatLlmCall` (002, 4.11, изменено спекой 004): сумма — из `charge`, если он есть, иначе `costMicroUsd`.

| Случай | Строка |
|---|---|
| `charge.basis: 'usage'` | как в 002: `chat-small · 1000 (кэш 200) → 500 ток. · $0.009960` |
| `usage` null, `charge.basis: 'estimate'`, `status: 'aborted'` | `chat-small · прерван · без usage · ≈$0.004500` |
| `usage` null, `charge.basis: 'estimate'`, `status: 'ok'` | `chat-small · без usage · ≈$0.000030` |
| `status: 'error'` | как в 002 |
| `charge` нет (до 004) | как в 002 |

`cabinet`:
- **Форма роя.** Поле «Бюджет, $» — по умолчанию `0.50` (Q-5), шаг `0.01`. У агента — поле «Бюджет агента, $», пустое — `null`. Перевод в micro-USD — `Math.round(usd × 10⁶)` в `ui-core` (`usdToMicro`), проверка — `SwarmCreateRequest`.
- **Страница роя.** Над графом — строка `formatSwarmMoney`, обновляется по каждому событию и раз в 5 с. У агента в списке — `formatUsd(spent)` и бюджет, если он задан.
- **Причина `swarm.failed`.** `budget_exceeded` → «бюджет исчерпан», `gateway_unavailable` → «шлюз моделей недоступен»; `detail` показывается рядом.

### 4.9. Цены из OpenRouter (из N-9)

**Источник.** `GET <OPENROUTER_MODELS_URL>` (по умолчанию `https://openrouter.ai/api/v1/models`), без ключа. В ответе `data[]`: `id` и `pricing` со строками USD за токен.

**Сопоставление.** Модель каталога с `openRouterModel` берёт цены из `data[]` с тем же `id`. Модели без `openRouterModel` не обновляются. В `dev` и `prod` поле равно модели `litellm_params.model` из `litellm.yaml` без префикса `openrouter/` (репозиторный тест).

**Перевод цены.** Строка за токен × 10⁶ → строка за 1 млн токенов, десятичным сдвигом без `Number`. Больше 4 знаков после точки — округление вверх до 4 знаков. Маппинг полей:
- `prompt` → `inputPerMTokUsd`;
- `completion` → `outputPerMTokUsd`;
- `input_cache_read` → `cachedInputPerMTokUsd`; нет поля — цена `prompt`.

**Модель не обновляется** (лог `warn` `price_update_skipped` с `model` и причиной), если:
- модели нет в ответе;
- строка не разбирается или результат не проходит `PricePerMTok`;
- в `pricing` ненулевое `request`, `image` или `web_search`.

`input_cache_write` не учитывается (Q-8).

**Функция ядра**, чистая:

```ts
export function applyOpenRouterPrices(
  catalog: ModelCatalog,
  response: unknown,
): { catalog: ModelCatalog; changed: { model: ModelId; from: ModelPrices; to: ModelPrices }[]; skipped: { model: ModelId; reason: string }[] };
```

Примеры, они же тесты AC-004-28:

| `pricing` | Результат (in / cached / out) |
|---|---|
| `prompt "0.000003"`, `completion "0.000015"`, `input_cache_read "0.0000003"` | `3` / `0.3` / `15` |
| `prompt "0.00000027"`, `completion "0.0000011"`, без `input_cache_read` | `0.27` / `0.27` / `1.1` |
| `prompt "0.00000000001"` | `0.0001` (округление вверх) |
| `prompt "0"`, `completion "0"` | `0` / `0` / `0` |
| `request "0.01"` | пропуск |
| `prompt "abc"` | пропуск |

Сравнение цен при `changed` — по значению (`"3"` и `"3.00"` равны).

**Хранение (Q-8).** Последние успешные цены — в `model_prices` (4.5) за портом `PriceStore`. Функция ядра, чистая:

```ts
// Цены из PriceStore поверх models.json: модель с openRouterModel, для которой есть сохранённая цена, берёт её.
export function applyStoredPrices(catalog: ModelCatalog, stored: StoredPrice[]): ModelCatalog;
```

**Оболочка.**
- Текущий каталог — в памяти процесса за `PriceBook`.
- При старте, после миграций и до `listen`: `models.json` → `applyStoredPrices(PriceStore.load())`. Ошибка чтения — старт падает, как при ошибке миграций.
- Обновление из OpenRouter после `checkUpstream` не задерживает приём запросов, потом — каждые `LLM_PRICES_REFRESH_MS`. При `0` или `LLM_PROFILE=test` запросов нет.
- Изменённые цены сначала пишутся `PriceStore.save` (`updatedAt` — `Clock.now`), потом подменяют каталог в памяти. На каждое `changed` — лог `info` `price_updated` с `model`, `from`, `to`.
- Ошибка `save` — лог `warn` `price_save_failed`, каталог в памяти не меняется: цены в памяти и в БД не расходятся, а следующий цикл увидит те же `changed` и повторит запись.
- Ошибка OpenRouter после повторов — лог `warn` `price_refresh_failed`, цены прежние.

**Адаптер `packages/adapter-openrouter`:** `createOpenRouterPrices({ url, timeoutMs }): { fetchModels(signal): Promise<unknown> }` на `fetch` с `retry` (4.10). Ответ не `2xx` — `HttpError` со `status` и `retryAfterMs` из `Retry-After`.

### 4.10. `@swag/helpers`: повтор (из N-10)

```ts
export interface RetryOptions {
  attempts?: number; // всего попыток, по умолчанию 4
  baseMs?: number; // по умолчанию 500
  maxMs?: number; // по умолчанию 30000
  retryable(err: unknown): false | { afterMs?: number }; // afterMs — из Retry-After
  sleep?(ms: number, signal?: AbortSignal): Promise<void>; // для тестов
  random?(): number; // [0, 1), для тестов
  signal?: AbortSignal;
}
export function retry<T>(fn: (attempt: number) => Promise<T>, options: RetryOptions): Promise<T>;

// @swag/helpers/server — хелперы над fetch, только для адаптеров и оболочек:
export class HttpError extends Error {
  constructor(readonly status: number, readonly retryAfterMs: number | null, message: string);
}
// Повторяемые: сетевые ошибки и таймаут (TypeError из fetch, AbortError по таймауту), HttpError 408, 429, 5xx. Остальные 4xx — нет.
export function httpRetryable(err: unknown): false | { afterMs?: number };
export function parseRetryAfter(value: string | null, now: Date): number | null; // секунды или HTTP-дата → мс
```

**Задержка перед попыткой `n + 1`:**

```
delay = min(maxMs, max(random() · min(maxMs, baseMs · 2^(n−1)), afterMs ?? 0))
```

Это «полный разброс» с нижней границей `Retry-After`.

- **Последняя попытка неудачна** — бросается её ошибка.
- **Неповторяемая ошибка** — бросается сразу.
- **`signal` прерван** — бросается `signal.reason`.

Пакет — без зависимостей, устройство — по [скиллу refactor](../../.claude/skills/refactor/SKILL.md#устройство-пакета): `retry` и `RetryOptions` — в универсальной точке входа `@swag/helpers`, `HttpError`, `httpRetryable` и `parseRetryAfter` — в `@swag/helpers/server`. Ядрам пакет импортировать нельзя: белый список ядер не расширяется, `arch:check` не меняется. Вызовы моделей через LiteLLM хелпер не используют: там повторяют LiteLLM и OpenAI SDK (022, Q-4).

### 4.11. Переменные окружения

| Переменная | Где | Значение | Назначение |
|---|---|---|---|
| `SWARM_MAX_BUDGET_MICRO_USD` | `ApiConfig` | целое ≥ 1, `.env.example`: `5000000` | предел бюджета роя (Q-5) |
| `LLM_GATEWAY_URL` | `OrchestratorConfig` | URL, `.env.example`: `http://llm-gateway:<порт>` | внутренний API gateway для оркестратора |
| `LLM_GATEWAY_TOKEN` | `OrchestratorConfig`, `LlmGatewayConfig`, `AgentConfig` | как в 002 и 022 | `/v1/*` и `/internal/*` |
| `DATABASE_URL` | `LlmGatewayConfig` | URL | бюджеты, ledger и цены |
| `LLM_PRICES_REFRESH_MS` | `LlmGatewayConfig` | целое ≥ 0, по умолчанию `3600000` | период цен; `0` — выключено |
| `OPENROUTER_MODELS_URL` | `LlmGatewayConfig` | URL, по умолчанию `https://openrouter.ai/api/v1/models` | источник цен; в тестах — фейк |

Compose:
- `llm-gateway` получает `DATABASE_URL` и `depends_on: postgres` и подключается к сети, где Postgres;
- `orchestrator` получает `LLM_GATEWAY_URL`.

Миграции при старте применяют и `api`, и `llm-gateway`: `runMigrations` уже ждёт advisory lock (003).

### 4.12. Ошибки gateway

Таблица 4.6 спеки 002 дополняется (изменено спекой 004):

| Случай | HTTP | `code` |
|---|---|---|
| роя нет в регистрации, рой закрыт или срок регистрации истёк, агента нет в регистрации роя | 403 | `caller_not_registered` |
| модель запроса не модель агента из регистрации | 403 | `model_not_allowed` |
| нет `max_tokens` и `max_completion_tokens` или они не целые ≥ 1 | 400 | `invalid_request` |
| не хватает бюджета роя | 402 | `swarm_budget_exceeded` |
| не хватает бюджета агента | 402 | `agent_budget_exceeded` |

Коды 002, в том числе `unauthorized` и `invalid_caller`, не меняются.

### 4.13. Команды

**`npm run money:report -- [--swarm <uuid>] [--since <ISO>]`** — `scripts/money-report.ts`: `DATABASE_URL` из `.env` → `ledgerReport` → печать:

```
calls 12 · charged $0.0421 (usage 11 / $0.0418, estimate 1 / $0.0003, none 0)
provider $0.0415 по 11 вызовам · без факта 1
charged vs provider по тем же вызовам: $0.0418 vs $0.0415 · +0.72%
```

Разница — `(charged − provider) / provider × 100`, два знака. При `provider = 0` — `n/a`. Суммы — через `formatUsd`.

**`npm run llm:ping`** (изменено спекой 004):
1. Регистрирует рой со случайным `swarmId`: бюджет 1000000, один агент `agent-1` с моделью из аргумента, `expiresAt` через 5 минут.
2. Вызывает модель с этим `swarmId` и `agent-1` в заголовках, как в 002.
3. Закрывает рой.

`max_tokens` по умолчанию 256. События такого роя `api` отбрасывает, как события неизвестного роя.

### 4.14. Пакеты и README

- **Новые пакеты с README по правилу 7:**
  - `packages/helpers`;
  - `packages/adapter-openrouter`;
  - `packages/adapter-gateway-http`.
- **Пакеты, README которых обновляется:** `contracts`, `llm-gateway-core`, `apps/llm-gateway` (регистрация роёв, внутренний API, цены — раздел «Обновление цен каталога» переписывается), `adapter-postgres`, `orchestrator-core`, `apps/orchestrator`, `adapter-openai` (коды `402` и `403`), `api-core`, `api-integration`, `ui-core`, `apps/ui/cabinet`, `config`.
- **Корневой README:** `npm run money:report`, бюджет роя, новые переменные.

## 5. Критерии приёмки

Тесты на Postgres пропускаются без `POSTGRES_TEST_URL`, как в 003; в CI он есть. Критерии `[stack]` — тесты против поднятого `npm run up` на профиле `test`, пропускаются без `LLM_GATEWAY_URL` (как в 002). Прогон со стеком прикладывается в журнал.

**Контракты и api**
- **AC-004-1** — *Given* `SwarmCreateRequest` без `budgetMicroUsd`, с `0`, с `1.5`, с `1_000_000_001`, а у агента `budgetMicroUsd: 0`. *When* `safeParse`. *Then* ошибка. С бюджетом 500000 и агентом без бюджета — успех, у агента `budgetMicroUsd: null`.
- **AC-004-2** — *Given* `maxBudgetMicroUsd: 5000000`. *When* `createSwarm` с бюджетом 5000001, отдельно с бюджетом агента больше бюджета роя. *Then* `validation_error`, событий нет, оркестратор не вызван. С бюджетом 500000 — `swarm.created` и `SwarmLaunch` несут бюджеты роя и агентов.
- **AC-004-3** — *Given* события `swarm.created` без `budgetMicroUsd` (до 004) и `llm.call` без `charge`. *When* `PlatformEventInput.safeParse`. *Then* успех.

**Ключи и внутренний API gateway**
- **AC-004-4** — *Given* ядро на `BudgetStore` в памяти теста. *When* `registerSwarm` с двумя агентами. *Then* `ok`, `register` получил рой, срок и агентов с моделями и бюджетами. Повтор с тем же `swarmId` — `409 swarm_registered`. Модель вне каталога — `400 model_not_found`, бюджет агента больше роя — `400 invalid_request`; в этих двух случаях `register` не вызван.
- **AC-004-5** — *Given* оболочка gateway. *When* `POST /internal/swarms` и `POST /internal/swarms/:id/close` без `Authorization` и с неверным токеном. *Then* `401 unauthorized`, ядро не вызвано. С верным токеном регистрация — `204`.
- **AC-004-6** — *Given* зарегистрированный рой A с агентами `agent-1` и `agent-2`. *When* вызов с `x-swag-swarm-id` незарегистрированного роя B; вызов от `agent-3` роя A; вызов от `agent-2` роя A. *Then* первые два — `403 caller_not_registered`, фейк не вызван, резерва, записи ledger и события нет; третий — `200`, событие `llm.call` с `swarmId` роя A и `agentId: 'agent-2'`.
- **AC-004-7** — *Given* агент роя с моделью `chat-small` в регистрации. *When* вызов с `model: 'chat-large'`. *Then* `403 model_not_allowed`, фейк не вызван, резерва и события нет.
- **AC-004-8** — *Given* зарегистрированный рой. *When*:
  - `closeSwarm`, затем вызов от агента роя;
  - отдельно: часы теста позже `expiresAt`, затем вызов.

  *Then*:
  - в обоих случаях `403 caller_not_registered`, фейк не вызван;
  - повторный `closeSwarm` возвращает тот же `spentMicroUsd`;
  - `closeSwarm` неизвестного роя — `404`.

**Резерв и списание**
- **AC-004-9** — *Given* строки таблиц 4.3. *When* `holdMicroUsd` и `chargeFor`. *Then* результаты как в таблице. `inputBytes` от сообщения с текстом `"ё"` на 1 байт больше, чем от сообщения с `"e"`.
- **AC-004-10** — *Given* запрос без `max_tokens` и с `max_tokens: 0`. *When* вызов. *Then* `400 invalid_request`, фейк не вызван.
- **AC-004-11** — *Given* бюджет роя меньше `holdMicroUsd` вызова. *When* вызов без потока и потоком. *Then* `402 swarm_budget_exceeded` в формате ошибки 002, фейк не вызван, `held` и `spent` не изменились, записи ledger и события нет, лог `warn` `budget_exceeded`.
- **AC-004-12** — *Given* у `agent-1` бюджет агента меньше оценки, у `agent-2` бюджета агента нет. *When* вызов каждым. *Then* `agent-1` — `402 agent_budget_exceeded`, `agent-2` — `200`.
- **AC-004-13** — *Given* Postgres, `createPostgresBudgetStore`, бюджет роя ровно на 5 резервов по 1000. *When* 20 параллельных `reserve` по 1000 от разных агентов. *Then*:
  - ровно 5 `ok: true`, 15 — `swarm_budget_exceeded`;
  - `held_micro_usd = 5000`, в `budget_holds` 5 строк.
  
  То же для бюджета агента.
- **AC-004-14** — *Given* Postgres. *When* `settle` резерва 1000 списанием 700. *Then* одной транзакцией:
  - строки резерва нет;
  - `held` роя и агента −1000, `spent` +700;
  - одна запись `ledger_entries` с полями `LedgerEntry`.
  
  Повтор `settle` того же `callId` новых записей не добавляет и `spent` не меняет.
- **AC-004-15** — *Given* ядро и фейк. *When*:
  - вызов без потока с `usage`;
  - поток с `usage`;
  - поток `__cut__` без `usage`;
  - `__fail_500__`.
  
  *Then* событие `llm.call` и запись ledger несут одинаковые `charge`: `usage`, `usage`, `estimate` по байтам дошедших фрагментов, `none` 0. `providerCostMicroUsd` в записи равен событию.
- **AC-004-16** — *Given* `usage` ответа дороже резерва. *When* вызов. *Then* списана стоимость по `usage`, лог `warn` `hold_exceeded` с `callId`, `holdMicroUsd`, `chargeMicroUsd`.
- **AC-004-17** — *Given* `settle` бросает. *When* вызов. *Then* клиент получает ответ `200`, событие опубликовано с `charge`, лог `error` `settle_failed` с `callId`.
- **AC-004-18** — *Given* Postgres с двумя строками `budget_holds` от прошлого процесса. *When* `releaseHolds` ядра. *Then* строк нет, `held` роёв и агентов уменьшен на их суммы, два лога `warn` `hold_released`, записей ledger нет. Оболочка вызывает его до приёма запросов (тест старта).
- **AC-004-19** — *Given* Postgres и ядро, рой из трёх агентов. *When*:
  - 12 вызовов вперемешку: без потока, потоком, с обрывом клиентом, с ошибкой;
  - затем `closeSwarm`.

  *Then* сумма `amount_micro_usd` записей роя = сумма `charge.microUsd` его событий = `spentMicroUsd` проекции по этим событиям (`projectSwarm`) = `spentMicroUsd` ответа закрытия.
- **AC-004-20** — *Given* миграции 0001 и 0002. *When* `runMigrations` дважды и параллельно из двух пулов. *Then* таблицы 4.5 есть ровно с этими колонками и ограничениями, ошибок нет.

**Оркестратор и агент**
- **AC-004-21** — *Given* `orchestrator-core` с фейковыми `LlmSwarms` и `SandboxProvider`, `swarmMs` 600000. *When* `launch` роя из двух агентов. *Then*:
  - `register` вызван до первого `create`, `expiresAt` = время часов + 660000 мс, модели и бюджеты агентов из `SwarmLaunch`;
  - `env` агентов — ровно как в 022 (AC-022-17).

  При `swarmMs` 0 `expiresAt` — `null`.
- **AC-004-22** — *Given* `register` бросает. *When* `launch`. *Then* `swarm.failed` `gateway_unavailable` с `detail`, `create` не вызван.
- **AC-004-23** — *Given* запущенный рой. *When* итог `completed`, `stopped`, `swarm_timeout` и `agent_failed`. *Then* в каждом случае `close` вызван один раз после уборки песочниц и до итогового события. Если `close` бросает — лог `warn` `gateway_close_failed`, итоговое событие опубликовано.
- **AC-004-24** — *Given* рой в `running`. *When* `agent.failed` от `agent-2` с `reason: 'model_error:swarm_budget_exceeded'`, отдельно — с `model_error:agent_budget_exceeded`. *Then* `swarm.failed` с причиной `budget_exceeded`, `detail` `agent-2: swarm_budget_exceeded` (`agent-2: agent_budget_exceeded`), все песочницы убраны.
- **AC-004-25** — *Given* `adapter-openai` и фейковый сервер. *When* сервер отвечает `402` с `code: 'swarm_budget_exceeded'`, отдельно — `403` с `code: 'caller_not_registered'`. *Then* `ok: false` с тем же кодом, сервер получил ровно один запрос: повторов нет.

**Проекция и UI**
- **AC-004-26** — *Given* события роя: `swarm.created` с бюджетом 500000 и бюджетом `agent-1` 100000, три `llm.call` двух агентов. *When* `projectSwarm`. *Then* `spentMicroUsd` роя и агентов — суммы `charge`. Событие без `charge` прибавляет `costMicroUsd`, при `null` — 0.
- **AC-004-27** — *Given* строки таблиц 4.8. *When* `formatSwarmMoney`, `formatLlmCall`, `formatUsd`, `spentLastMinute` с событиями на границе 60 с. *Then* строки ровно как в таблицах. Событие ровно в `nowMs − 60000` не входит, в `nowMs` входит. `usdToMicro('0.50')` = 500000.

**Цены и повторы**
- **AC-004-28** — *Given* строки таблицы 4.9. *When* `applyOpenRouterPrices`. *Then*:
  - цены и пропуски как в таблице;
  - модель без `openRouterModel` не меняется;
  - модели нет в ответе — `skipped`;
  - те же цены в другой записи (`"3"` и `"3.00"`) — не `changed`.
- **AC-004-29** — *Given* фейковый сервер OpenRouter и оболочка gateway с `LLM_PRICES_REFRESH_MS` 200. *When* старт, затем сервер меняет цену `chat-small`, затем сервер отвечает `500` до конца теста. *Then*:
  - до первого ответа сервера стоимость считается по `models.json`;
  - после смены — по новой цене, лог `info` `price_updated`;
  - после `500` — по последней успешной, лог `warn` `price_refresh_failed`.

  С `LLM_PRICES_REFRESH_MS=0` и отдельно с `LLM_PROFILE=test` сервер не получил ни одного запроса.
- **AC-004-30** — *Given* файлы `infra/llm/{dev,prod}/`. *When* репозиторный тест. *Then* у каждой модели `models.json` есть `openRouterModel`, равный `litellm_params.model` этой модели из `litellm.yaml` без префикса `openrouter/`. В `test` поля нет.
- **AC-004-31** — *Given* `retry` с фейковыми `sleep` и `random() = 0.5`, `baseMs` 100, `maxMs` 1000. *When*:
  - `fn` падает сетевой ошибкой трижды и на четвёртой попытке успешна;
  - `HttpError` 400;
  - `HttpError` 429 с `retryAfterMs` 800;
  - все 4 попытки неудачны;
  - `signal` прерван во время паузы.

  *Then*:
  - паузы 50, 100, 200, результат четвёртой попытки;
  - после 400 — одна попытка, ошибка 400;
  - пауза ровно 800;
  - ошибка четвёртой попытки;
  - `signal.reason`.

  `parseRetryAfter('3')` — 3000, HTTP-дата через 2 с — 2000, `'abc'` — `null`.

**Команды, стек и безопасность**
- **AC-004-32** — *Given* Postgres с записями ledger двух роёв: базис `usage`, `estimate` и `none`, часть без `provider_cost_micro_usd`. *When* `ledgerReport` по рою и по `since`. *Then* суммы и счётчики по 4.5, строки `money:report` по формату 4.13, при нулевом факте — `n/a`.
- **AC-004-33** — *Given* вызов с маркером `MARKER-7f3a`, регистрация и закрытие роя. *When* вызов завершён и `money:report` выполнен. *Then* значения `LLM_GATEWAY_TOKEN` нет:
  - в логах gateway и оркестратора (память экспортёров);
  - в событиях;
  - в строках всех таблиц 4.5.
- **AC-004-34** `[stack]` — *Given* `npm run up` с `LLM_PROFILE=test`, рой из двух агентов через `POST /swarms` с бюджетом 500000. *When* рой завершён. *Then*:
  - в `swarm_budgets` у роя `closed_at` задан, в `swarm_agents` два агента с моделями из запроса;
  - сумма `ledger_entries` роя равна `spentMicroUsd` в `GET /swarms/:id`;
  - вызов gateway с заголовками этого роя после завершения даёт `403 caller_not_registered`.
- **AC-004-35** `[stack]` — *Given* стек `test`, рой с бюджетом 1 (меньше одного вызова `chat-small`). *When* рой запущен. *Then* `swarm.failed` с причиной `budget_exceeded`, в `docker ps -a --filter label=swag.kind` пусто, записей ledger роя нет.
- **AC-004-36** `[manual]` — *Given* профиль `prod`, ключ OpenRouter с кредитами, цены обновлены из OpenRouter (лог `price_updated` или цены совпадают). *When*:
  - запомнить кредиты `GET https://openrouter.ai/api/v1/credits`;
  - прогнать рой S-3 на `chat-small`;
  - выполнить `npm run money:report -- --swarm <id>`;
  - через 5 минут снова запросить кредиты.

  *Then* в пределах ±1%:
  - `charged` отличается от `provider`;
  - `provider` отличается от разницы кредитов.

  Проверка: вывод команды и оба ответа `credits` — в журнал. Платные вызовы — только этот прогон.
- **AC-004-37** `[manual]` — *Given* стек `test`, UI. *When* рой S-3 на фейке. *Then*:
  - строка денег растёт с каждым `llm.call` без обновления страницы;
  - остаток уменьшается;
  - у агентов видны суммы;
  - рой с бюджетом `0.01` падает с «бюджет исчерпан» и `detail`.

  Проверка: скриншот в журнал.
- **AC-004-38** `[manual]` — из N-14 и S-3. *Given* `LLM_PROFILE=dev` с закреплённой моделью `chat-small`. *When* три прогона S-3. *Then* ни один рой не падает с `model_error:max_tokens`. Проверка: исходы роёв в журнал, модель и дата — в README `apps/llm-gateway`.
- **AC-004-39** — изменённый AC-002-25 и `scripts/llm-ping.test.ts`. *Given* фейковый gateway. *When* `llm:ping`. *Then* по порядку: `POST /internal/swarms` с токеном, вызов с токеном и заголовками `x-swag-*` того же роя, `close`; вывод как в 002.
- **AC-004-40** — *Given* Postgres, фейковый сервер OpenRouter и оболочка gateway. *When*:
  - старт 1: сервер отдаёт новую цену `chat-small`;
  - стоп, затем старт 2: сервер отвечает `500`;
  - отдельно: `PriceStore.save` бросает.

  *Then*:
  - после старта 1 в `model_prices` строка с `openRouterModel` модели и новой ценой;
  - на старте 2 до первого запроса к серверу стоимость считается по сохранённой цене, а не по `models.json`;
  - при ошибке `save` — лог `warn` `price_save_failed`, стоимость по прежней цене, в следующем цикле `save` вызван снова.

  `createPostgresPriceStore`: повторный `save` той же модели обновляет строку; `"3.0000"` в БД читается как `"3"`. `applyStoredPrices`: модель без `openRouterModel` и модель без сохранённой цены не меняются.

## 6. Нефункциональные требования

| ID | Требование | Как измеряется |
|---|---|---|
| NFR-004-1 | `reserve` + `settle` на локальном Postgres: p95 < 10 мс на пару | бенчмарк `POSTGRES_BENCH=1` в `adapter-postgres` (как NFR-003-2): 1000 пар последовательно и 1000 пар в 10 потоков одного роя; p50 и p95 — в журнал |
| NFR-004-2 | Лишняя задержка ответа gateway из-за денег: p95 < 15 мс | тот же прогон через ядро с фейковым апстримом без задержки, сравнение с 002 |

## 7. Безопасность: что не должно сломаться

- **Вызов от роя, который не запущен или уже завершён, и от агента не из роя не доходит до провайдера** → AC-004-6, AC-004-8, AC-004-34.
- **Агент не вызывает модель не из регистрации** → AC-004-7.
- **Внутренний API недоступен без токена** → AC-004-5.
- **Токен gateway не попадает в логи, события и таблицы** → AC-004-33.
- **Известное ограничение (Q-2).** Общий `LLM_GATEWAY_TOKEN` остаётся в песочнице агента, как в 022: код в песочнице может назвать чужой рой заголовками или вызвать `/internal/*`. Допустимо, пока в песочнице агента только код платформы; недоверенный код работает в отдельной песочнице без токена. Нарушение принципа — повод вернуть ключ агента отдельной спекой.
- **Бюджет не превышается параллельными вызовами** → AC-004-13. Превышение возможно только на `hold_exceeded` и видно в логе → AC-004-16.
- **Вызов сверх бюджета не доходит до провайдера** → AC-004-11, AC-004-12, AC-004-35.
- **Ключи провайдеров**: правила 002 (REQ-002-5, REQ-002-11, AC-002-21, AC-002-22) не меняются; `DATABASE_URL` у gateway — не ключ провайдера и в песочницу не передаётся.
- **`npm run check` без сети к OpenRouter** → AC-004-29, профиль `test`.

## 8. Задачи для агента

Выполняются по порядку. После каждой задачи — коммит.

Задачи ломают соседей до следующих задач:
- обязательный бюджет в `SwarmCreateRequest` (T-1) ломает `api` и форму UI до T-13 и T-15;
- проверка вызывающего по регистрации (T-5) отклоняет вызовы роёв, пока оркестратор их не регистрирует (T-10, T-11).

Поэтому вся спека идёт группой через фича-ветку `spec/004-money`, как в [implement-spec](../../.claude/skills/implement-spec/SKILL.md#ветка-на-этап):
- каждая задача — своя ветка `spec/004-tN` и PR в фича-ветку;
- внутри группы `npm run check` может быть красным там, где ждёт следующих задач, тесты самой задачи — зелёные;
- в `main` — после T-20.

- [x] **T-1.** Контракты 4.1:
  - `llm.ts`, `swarm.ts`, `events.ts` в `packages/contracts/src`;
  - README `contracts`, глоссарий.

  Закрывает: REQ-004-2, AC-004-1, AC-004-3. Готово, когда: тесты контрактов зелёные, `npm run typecheck` зелёный там, где не ждёт T-13 и T-15.
- [x] **T-2.** Пакет `packages/helpers` по 4.10 (из N-10):
  - `retry` в `@swag/helpers`, `HttpError`, `httpRetryable` и `parseRetryAfter` в `@swag/helpers/server`;
  - без зависимостей;
  - README, строка в разделе «Пакеты» `docs/architecture.md`, глоссарий. Закрывает: REQ-004-21, AC-004-31. Готово, когда: тесты пакета зелёные.
- [x] **T-3.** `adapter-postgres`:
  - миграция `0002_money.sql` по 4.5;
  - `createPostgresBudgetStore` (`register`, `findAgent`, `reserve`, `settle`, `close`, `releaseHolds`), `createPostgresPriceStore` и `ledgerReport` — SQL ровно по 4.5;
  - типы `BudgetStore` и `PriceStore` импортируются из `@swag/llm-gateway-core`, порты объявить там же в этом коммите — только интерфейсы 4.4, без логики;
  - бенч NFR-004-1;
  - README.

  Закрывает: REQ-004-9, REQ-004-10, AC-004-13, AC-004-14, AC-004-18 (часть хранилища), AC-004-20, AC-004-32, AC-004-40 (часть хранилища), NFR-004-1. Готово, когда: тесты адаптера зелёные с `POSTGRES_TEST_URL`.
- [x] **T-4.** `llm-gateway-core`, чистые функции 4.3: `inputBytes`, `holdMicroUsd`, `outputBytes`, `chargeFor`; тесты по таблицам. Закрывает: AC-004-9. Готово, когда: тесты ядра зелёные.
- [x] **T-5.** `llm-gateway-core`:
  - `complete` с шагами 4.3, `registerSwarm`, `closeSwarm`, `releaseHolds`, порт `PriceBook` вместо цен каталога;
  - события с `charge`, логи 4.4;
  - тесты на `BudgetStore` в памяти теста (`test/fake-budgets.ts`); тесты 002 на `complete` регистрируют рой перед вызовом;
  - README.

  Закрывает: REQ-004-4…REQ-004-6, REQ-004-8, REQ-004-10…REQ-004-14, AC-004-4, AC-004-6…AC-004-8, AC-004-10…AC-004-12, AC-004-15…AC-004-18. Готово, когда: тесты ядра зелёные.
- [x] **T-6.** `apps/llm-gateway`:
  - маршруты `/internal/*` по 4.2 с `LLM_GATEWAY_TOKEN`;
  - `DATABASE_URL`, `runMigrations` и `releaseHolds` до `listen`;
  - `PriceBook` из каталога, пока без обновления;
  - `LlmGatewayConfig` (4.11), compose (сеть с Postgres, `depends_on`), `.env.example` и локальный `.env`;
  - тесты 002 на `/v1/*` регистрируют рой перед вызовом, в том числе `[stack]` AC-002-20;
  - README.

  Закрывает: REQ-004-7, AC-004-5, AC-004-18 (старт), AC-004-19. Готово, когда: тесты `apps/llm-gateway` зелёные.
- [x] **T-7.** `scripts/llm-ping.ts` по 4.13 и его тест. Закрывает: AC-004-39. Готово, когда: тест зелёный.
- [x] **T-8.** `llm-gateway-core`: `applyOpenRouterPrices` и `applyStoredPrices` по 4.9 (из N-9), тесты по таблице. Закрывает: AC-004-28, AC-004-40 (`applyStoredPrices`). Готово, когда: тесты ядра зелёные.
- [x] **T-9.** Обновление цен (из N-9):
  - пакет `packages/adapter-openrouter` на `@swag/helpers`;
  - чтение `PriceStore` при старте, таймер, запись изменённых цен и `PriceBook` в `apps/llm-gateway` по 4.9, переменные 4.11;
  - `openRouterModel` в `infra/llm/{dev,prod}/models.json` и репозиторный тест в `scripts/repo.test.ts`;
  - фейковый сервер OpenRouter — в тесте оболочки;
  - README `adapter-openrouter` и `apps/llm-gateway` (раздел «Обновление цен каталога» переписать).

  Закрывает: REQ-004-20, REQ-004-22, AC-004-29, AC-004-30, AC-004-40. Готово, когда: тесты зелёные без сети.
- [x] **T-10.** `orchestrator-core`:
  - порт `LlmSwarms`, регистрация и закрытие по 4.6;
  - причины `budget_exceeded` и `gateway_unavailable`;
  - README.

  Закрывает: REQ-004-3, REQ-004-15, REQ-004-16, AC-004-21…AC-004-24. Готово, когда: тесты ядра зелёные.
- [x] **T-11.** Пакет `packages/adapter-gateway-http` по 4.6 с тестом на локальном HTTP-сервере; `apps/orchestrator`: сборка `LlmSwarms`, `LLM_GATEWAY_URL` в `OrchestratorConfig`, compose, `.env.example` и локальный `.env`; README. Закрывает: REQ-004-3. Готово, когда: тесты пакета и оболочки зелёные.
- [x] **T-12.** `adapter-openai`: тест AC-004-25 на коды 4.12; если SDK повторяет `402` или `403` — отключить повтор для них; README. Закрывает: AC-004-25. Готово, когда: тесты зелёные, `npm run check` зелёный на фича-ветке.
- [x] **T-13.** `api-integration` и `api-core`:
  - деньги в `SwarmView` и `applyEvent` по 4.7;
  - проверка бюджета в `createSwarm`, `SWARM_MAX_BUDGET_MICRO_USD` в `ApiConfig` и сборке `apps/api`;
  - `.env.example` и локальный `.env`;
  - README.

  Закрывает: REQ-004-1, REQ-004-2, AC-004-2, AC-004-26. Готово, когда: тесты зелёные.
- [x] **T-14.** `ui-core`: `formatUsd`, `usdToMicro`, `spentLastMinute`, `formatSwarmMoney`, `formatLlmCall` по 4.8, тесты по таблицам, README. Закрывает: AC-004-27. Готово, когда: тесты зелёные.
- [x] **T-15.** `apps/ui/cabinet`:
  - поля бюджета в форме;
  - строка денег и суммы агентов на странице роя, таймер 5 с;
  - тексты причин;
  - README.

  Закрывает: REQ-004-17. Готово, когда: сборка и тесты cabinet зелёные.
- [x] **T-16.** `scripts/money-report.ts`, скрипт `money:report` в корневом `package.json`, корневой README. Закрывает: REQ-004-19, AC-004-32 (формат вывода). Готово, когда: тест скрипта на Postgres зелёный.
- [ ] **T-17.** Тесты безопасности и стека:
  - AC-004-33 в `apps/llm-gateway` и `orchestrator-core`;
  - `[stack]` AC-004-34 и AC-004-35.

  Закрывает: REQ-004-18, AC-004-33…AC-004-35. Готово, когда: тесты зелёные, прогон со стеком — в журнале.
- [ ] **T-18.** Профиль `dev` (из N-14): закрепить в `infra/llm/dev/litellm.yaml` для `chat-small` бесплатную модель OpenRouter (`:free`). Правила выбора:
  - в `supported_parameters` каталога OpenRouter есть `tools`;
  - нет `reasoning` и `include_reasoning`;
  - контекст ≥ 32k.

  `openRouterModel` — в `models.json`. Прогон S-3 трижды. Нет такой модели — вопрос человеку, задачу не делать. Закрывает: REQ-004-23, AC-004-38. Готово, когда: исходы прогонов и модель с датой — в журнале и README `apps/llm-gateway`.
- [ ] **T-19.** Тексты чужих спек с пометкой «изменено спекой 004»:
  - 001 — тело `POST /swarms`, `swarm.created`;
  - 002 — 4.1, 4.2 (порядок проверок), 4.4 (`BudgetStore`, `PriceBook`), 4.6, 4.7 (`openRouterModel`), 4.9, 4.11, 4.13;
  - 022 — разделы 2 и 7: `LLM_GATEWAY_TOKEN` в песочнице остаётся не «до 004», а по Q-2 спеки 004.

  Плюс глоссарий и журналы этих спек. Готово, когда: тексты сверены с кодом.
- [ ] **T-20.** Ручные проверки AC-004-36 и AC-004-37, NFR-004-2, журнал, сверка README, `npm run check`, статус `review`. Закрывает: AC-004-36, AC-004-37, NFR-004-2. Готово, когда: всё зелёное, результаты в журнале.

## 9. Открытые вопросы

Пока список не пуст, спека не может быть `ready`. Все вопросы решены человеком 2026-10-30.

- [x] **Q-1. Устройство ledger и резервов** (из D-5 и части D-38 «Устройство ledger»). *(Claude, 2026-10-29)*
  - **Направление суммы.**
    - **(а)** Сумма со знаком: пополнение > 0, трата < 0.
    - **(б)** Сумма всегда ≥ 0, направление задаёт `kind`.
  - **Резерв.**
    - **(а)** Отдельная таблица `budget_holds`.
    - **(б)** Записи `hold` и `release` в самом ledger.
  - **Двойная запись (D-38 «а»).** У платформы свои счета, каждое списание — проводка «бюджет роя → выручка платформы».
    - **(а)** Сразу в 004.
    - **(б)** В 013, когда появятся балансы организаций и счета платформы.

  **Рекомендация:**
  - **«б», «а», «б»:**
    - в 004 нет ни балансов, ни пополнений, ни счетов. Единственная операция — трата роя на модель, и двойная запись дала бы одну пару счетов;
    - `kind` и положительная сумма читаются проще и не путают знак в отчётах;
    - резерв — не факт расхода, ledger остаётся только фактом;
    - маржа платформы считается отчётом по `provider_cost_micro_usd` (4.13).
  - Цена решения: в 013 ledger, скорее всего, перейдёт к проводкам с миграцией данных.
  - Части D-38 про поступления, остаток кредитов у провайдера и видимость `providerCostMicroUsd` остаются в `questions.md` за 013, 025 и 014.

  **Решение человека (2026-10-30): «б», «а», «б» — по рекомендации.**
- [x] **Q-2. Как gateway узнаёт рой и агента вызова.** *(Claude, 2026-10-29; рекомендация изменена 2026-10-30)*
  - **(а)** Ключ агента: регистрация роя возвращает ключи, gateway хранит хэши и берёт рой, агента и модель из ключа (4.2, как в черновике).
  - **(б)** Оркестратор сам выпускает подписанный токен (HMAC по общему секрету) с `swarmId`, `agentId`, моделью и сроком. Gateway проверяет его без БД, а отзыв — по закрытому рою в Postgres.
  - **(в)** Общий `LLM_GATEWAY_TOKEN` и заголовки `x-swag-swarm-id`, `x-swag-agent-id`, как в 002. Регистрация роя через `/internal/swarms` остаётся, но без ключей: gateway получает бюджеты роя и агентов и модели агентов. Вызов от незарегистрированного или закрытого роя, от агента не из регистрации или к чужой модели — отказ без обращения к LiteLLM.

  **Рекомендация — «в».** Принцип от человека (2026-10-30): недоверенный код (скиллы, исполнение кода) никогда не работает в песочнице агентского цикла. Для него — отдельная песочница без доступа к критичным данным, наружу — только через функции-обёртки и сервисы. Тогда в песочнице агента только наш код, и общий токен в env не открывает подмену роя.
  - ключ агента в этой схеме защищает только от ошибок в нашем коде — мало за его цену;
  - 004 короче на 3–4 задачи: нет `agent_keys` с хэшами, `AgentKey`, адаптера ключей в агенте; `adapter-openai`, `AgentConfig`, заголовки и `invalid_caller` не меняются;
  - бюджет агента и модель агента хранятся в регистрации роя (таблица агентов роя вместо `agent_keys`);
  - если принцип нарушится (недоверенный код в песочнице агента), ключ агента возвращается отдельной спекой.


  **Решение человека (2026-10-30): «в» — по рекомендации.** Разделы 2–8 переписаны под регистрацию роя без ключей, строка роадмапа (раздел 1 и этап 4) — тоже.
- [x] **Q-3. Верхняя оценка вызова.** Резерв должен быть не меньше фактической стоимости, но токенизатора у gateway нет. *(Claude, 2026-10-29)*
  - **Оценка входа.**
    - **(а)** Байты UTF-8 сообщений и инструментов: токен не меньше байта, поэтому оценка не занижает, но завышает в 3–4 раза.
    - **(б)** Токенизатор (`tiktoken`) — точнее, но не у всех моделей свой и это лишняя зависимость.
    - **(в)** Фиксированный резерв на вызов.
  - **Выход.**
    - **(а)** Поле `max_tokens` обязательно: агент его уже шлёт.
    - **(б)** Без `max_tokens` — лимит выхода модели из каталога (новое поле `maxOutputTokens`).

  **Рекомендация — «а» и «а»:**
  - без зависимостей и без новых полей каталога;
  - завышенный резерв возвращается в бюджет сразу после ответа.

  Цена: рой с бюджетом впритык получает `402` раньше, чем исчерпан бюджет по факту.

  **Решение человека (2026-10-30): «а» и «а» — по рекомендации.**
- [x] **Q-4. Что списывать за вызов без `usage`** (из Q-1 спеки 002: «правило списания — в 004»). Такое бывает:
  - у оборванного потока;
  - у ответа без `usage`;
  - у обрыва клиентом.

  Провайдер в этих случаях обычно уже взял деньги. *(Claude, 2026-10-29)*
  - **(а)** Ничего, как в 002: бесплатно для клиента, убыток платформы.
  - **(б)** Весь резерв: завышено в разы.
  - **(в)** Оценка по байтам: вход плюс дошедший выход (4.3).

  Вызов с ошибкой апстрима до ответа — бесплатно во всех вариантах.

  **Рекомендация — «в»:** верхняя граница фактического расхода по тому, что реально ушло и пришло; в ленте помечается «≈».

  **Решение человека (2026-10-30): «в» — по рекомендации.**
- [x] **Q-5. Пороги бюджета.** *(Claude, 2026-10-29)*
  - Бюджет роя обязателен в `POST /swarms` или есть значение по умолчанию?
  - Предел `SWARM_MAX_BUDGET_MICRO_USD`.
  - Значение по умолчанию в форме.
  - Нужен ли бюджет агента в MVP.

  **Рекомендация:**
  - бюджет обязателен в API — нет скрытого «бесконечного» бюджета;
  - предел — $5 (`5000000`);
  - в форме по умолчанию $0.50;
  - бюджет агента — необязательный, пустой в форме. Это защита от одного зациклившегося агента: роадмап называет «бюджеты агента и роя».

  Числа — решение человека.

  **Решение человека (2026-10-30): по рекомендации** — бюджет обязателен, предел `5000000`, в форме $0.50, бюджет агента необязательный.
- [x] **Q-6. Сверка** (из этапа 4 «сверка с логами LiteLLM и счетами провайдера ±1%» и части D-38 «Фактическая стоимость вызова»). *(Claude, 2026-10-29)*
  - **Логи LiteLLM.** По D-21 у LiteLLM нет БД и spend logs, а свою стоимость он считает по своим ценам, а не по ценам платформы.
    - **(а)** Отказаться от сверки с логами LiteLLM и сверять с фактической стоимостью из ответа провайдера (`usage.cost`, уже в 002) и с кредитами OpenRouter.
    - **(б)** Включить callback LiteLLM в файл и сверять с ним.
  - **Вызовы, где факт `null`.**
    - **(а)** Считаются отдельной строкой отчёта.
    - **(б)** Дозапрашиваются у OpenRouter (`GET /api/v1/generation?id=`) — нужен id генерации из ответа.
  - **Как проверять ±1% (критерий MVP 4).**
    - **(а)** Ручной прогон на `prod` с дешёвой моделью, AC-004-36.
    - **(б)** Отдельный профиль `dev-paid` (S-2).

  **Рекомендация — «а», «а», «а»:**
  - факт провайдера по каждому вызову уже приходит, логи LiteLLM сверх него ничего не дают;
  - профиль `dev-paid` нужен S-2 и делается вместе с 025.


  **Решение человека (2026-10-30): «а», «а», «а» — по рекомендации.** Строка этапа 4 в роадмапе исправлена.
- [x] **Q-7. Резервные провайдеры** (из D-39: «отдельная спека после 004 или 004»). *(Claude, 2026-10-29)*
  - **(а)** В 004.
  - **(б)** Отдельная спека после 004, до выхода в `prod`.

  **Рекомендация — «б»:**
  - 004 и так большой;
  - резерв меняет `litellm.yaml`, каталог цен (второй набор цен для факта) и событие `llm.call` (признак пути) — это отдельная тема;
  - D-39 возвращается в `questions.md` с «куда — спека после 004».

  **Решение человека (2026-10-30): «б» — по рекомендации.** D-39 возвращён в `questions.md`.
- [x] **Q-8. Цены и кэш промпта** (из N-9 и D-37). *(Claude, 2026-10-29)*
  - **Где хранить последние цены между перезапусками.**
    - **(а)** Только в памяти, холодный старт — `models.json`.
    - **(б)** Таблица в Postgres.
  - **Округление цены, если у OpenRouter больше 4 знаков.**
    - **(а)** Вверх до 4 знаков.
    - **(б)** Расширить `PricePerMTok` до 6 знаков.
  - **Бизнес-правило кэша (D-37).**
    - **(а)** Экономия на кэше достаётся клиенту, списание по `cached`, как сейчас.
    - **(б)** Фиксированная цена входа.
  - **Цена записи в кэш (`input_cache_write`) и кэш ответов LiteLLM.**
    - **(а)** Не в 004.
    - **(б)** В 004.

  **Рекомендация — «а», «а», «а», «а»:**
  - после перезапуска цены и так обновятся при старте;
  - 4 знака — это $0.0001 за 1 млн токенов;
  - «а» по D-37 прозрачно;
  - у моделей `dev` и `prod` (бесплатные и DeepSeek) кэш неявный, без цены записи.


  **Решение человека (2026-10-30): хранение — «б», остальное — «а», «а», «а».** Последние успешные цены — в таблице `model_prices` (4.5, 4.9): после перезапуска списание идёт по ним, а не по `models.json`. D-37 сужен до цены записи в кэш и кэша ответов и возвращён в `questions.md`.

## 10. Журнал реализации

Заполняет агент.

| Дата | Ветка / коммит | Что сделано | Отклонения от спеки |
|---|---|---|---|
| 2026-10-30 | `spec/004-money` | Спека взята в работу. Все задачи T-1…T-20 идут группой через фича-ветку `spec/004-money` (раздел 8): обязательный бюджет (T-1) ломает `api` и UI до T-13 и T-15, проверка регистрации (T-5) — вызовы роёв до T-10 и T-11. Ветка задачи `spec/004-tN` — от фича-ветки, PR — в неё. | — |
| 2026-10-30 | `spec/004-t1` | T-1 контракты. | Отклонение от 4.1: `LlmSwarmRegistration` и `LlmSwarmClosed` объявлены в `swarm.ts`, а не в `llm.ts` — `swarm.ts` уже импортирует `llm.ts`, обратный импорт дал бы цикл (так же лежит `LlmCaller`). |
| 2026-10-30 | `spec/004-t3`, коммит `4c6e89d` | T-3 хранилища. Миграция `0002_money.sql` по 4.5 без изменений; `createPostgresBudgetStore`, `createPostgresPriceStore`, `ledgerReport` в `adapter-postgres`. Порты `BudgetStore`, `PriceStore` и типы `RegisteredAgent`, `ReserveResult`, `LedgerEntry`, `StoredPrice` в `llm-gateway-core`. Новые имена в глоссарии: «Результат резерва» (`ReserveResult`), `RegisteredAgent`. | Отклонение в `settle`: вставка в `ledger_entries` (`on conflict do nothing`) идёт первой, при конфликте транзакция откатывается. Причина: буквальный порядок 4.5 (удалить hold, обновить held и spent, вставить ledger) при повторе того же `callId` снова прибавляет spent, что нарушает AC-004-14. Семантика AC сохранена; текст 4.5 — на правку человеку, D-90 в `questions.md`. Трактовка: `reserve` для агента, которого нет в `swarm_agents`, возвращает `agent_budget_exceeded` (ядро проверяет агента через `findAgent` раньше). NFR-004-1, локальный Postgres (`synchronous_commit=on`), 1000 пар reserve+settle: последовательно p50 6.83 мс, p95 7.97 мс — укладывается; 10 потоков одного роя p50 35.70 мс, p95 80.03 мс — не укладывается. Причина — сериализация на строке `swarm_budgets`, которую предписывает 4.5 (блокировка держится до commit с fsync). Ревью проверило: даже вариант одним statement с CTE даёт p95 больше 10 мс в 10 потоках, `synchronous_commit=off` — 31 мс. Решение — человеку, D-89 в `questions.md`. |
| 2026-10-30 | `spec/004-t5` | T-5 ядро: `complete` с проверкой регистрации, `max_tokens`, резервом до апстрима и списанием после него (в том числе при отказе, обрыве и потоке); `registerSwarm`, `closeSwarm`, `releaseHolds`; порт `PriceBook` вместо цен каталога; `charge` в `llm.call`; логи 4.4 (`settle_failed`, `hold_exceeded`, `hold_released`, `budget_exceeded`). Тесты: `test/money-register.test.ts` (AC-004-4, -6, -7, -8), `test/money-settle.test.ts` (AC-004-10, -11, -12, -15…-18), фейк `test/fake-budgets.ts`. Тесты 002 получили `max_tokens` и регистрацию роя через `fakeDeps`; их ожидания дополнены полями `charge` и `chargeBasis`/`chargeMicroUsd`. README. | Отклонения: (1) тесты 002 регистрируют рой через `fakeDeps` по умолчанию (`budgets.seed(TEST_SWARM)`; `registered: false` отключает), а не отдельным вызовом `registerSwarm` в каждом тесте — DRY, минимальные правки тестов 002. (2) Порядок проверок `registerSwarm` — по REQ-004-6; `maxOut` — по формуле 4.3 (`max_tokens ?? max_completion_tokens`), любое невалидное значение — один текст `max_tokens is required` (D-91 и D-94 сняты как закрытые спекой). (3) Лог `call_refused` на отказах шагов 2–7; имя на подтверждении, D-92 в `questions.md`. (4) Резерв потока без итерации — D-93 в `questions.md`, на решение человека. Сломано в потребителях, чинит T-6 и далее: `apps/llm-gateway/test/support.ts` (нет `budgets` и `prices` в `LlmGatewayDeps`), `packages/api-core/src/index.ts:205` (`createSwarm` без `budgetMicroUsd`, как и в T-1). |
| 2026-10-30 | `spec/004-t6` | T-6 оболочка: `POST /internal/swarms` и `POST /internal/swarms/:swarmId/close` по 4.2 с `authorize` как у `/v1/*`; `startLlmGatewayCore` (миграции, пул, `createPostgresBudgetStore`, `catalogPriceBook`, `releaseHolds` до возврата из `startLlmGatewayCore` (`main.ts` вызывает `listen` после него; `main.ts` не покрыт тестом); `DATABASE_URL` в `LlmGatewayConfig`; compose (`DATABASE_URL`, `depends_on: postgres`); `pg` и `@swag/adapter-postgres` в `apps/llm-gateway`. Тесты: `test/support.ts` переведён на фейк хранилища из ядра и каталожный `PriceBook`; тесты 002 получили `max_tokens`, `[stack]` регистрирует рой; новые `test/internal.test.ts` (AC-004-5, REQ-004-6 через оболочку) и `test/money-postgres.test.ts` (AC-004-18 старт, AC-004-19 сверка ledger с Postgres). README и глоссарий. | Отклонения: (1) AC-004-19 закрыт частично: сверка ledger, `charge` событий и ответа закрытия; сверка с `projectSwarm` — в T-13 (AC-004-26), см. D-95. (2) `closeSwarm` с не-UUID отвечает `404 not_found` в ядре, не `500` от Postgres (тест в `money-register.test.ts`, AC-004-8). (3) Формат `/internal/*` без `type`, `/v1/*` — с `type`, по 4.2 и 002. (4) `DATABASE_URL` уже есть в `.env.example` и `.env` как общая переменная для `api`, добавлять не понадобилось. (5) В `[stack]` тело запроса к `api` получило `budgetMicroUsd` по контракту 4.1. |
| 2026-10-30 | `spec/004-t7` | T-7 `scripts/llm-ping.ts` по 4.13: регистрация роя (`POST /internal/swarms`, `LlmSwarmRegistration` из `@swag/contracts`, UUID, бюджет 1000000, `agent-1` с моделью из аргумента, `expiresAt` +5 минут), вызов с `x-swag-swarm-id` и `x-swag-agent-id: agent-1`, `max_tokens: 256`, закрытие `POST /internal/swarms/:swarmId/close` в `finally`. Вывод как в 002. Тест `scripts/llm-ping.test.ts`: фейковый шлюз пишет все запросы; AC-004-39 — порядок трёх запросов, тело регистрации по контракту, заголовки, закрытие при ошибке модели; кейсы REQ-002-17 (без потока, поток, 401) переведены на новый фейк. Корневой README (строка `llm:ping` и таблица команд). | — |
| 2026-10-30 | `spec/004-t8` | T-8 `llm-gateway-core`: `applyOpenRouterPrices` и `applyStoredPrices` по 4.9. Перевод цены — строка за токен × 10⁶ десятичным сдвигом (без `Number`), больше 4 знаков — округление вверх; маппинг `prompt`, `completion`, `input_cache_read` (нет — цена `prompt`); пропуски с причиной по 4.9; сравнение по значению. `applyStoredPrices` — ключ `openRouterModel`. Тесты `test/money-prices.test.ts`: AC-004-28 по таблице 4.9 (все 6 строк) и AC-004-40 (часть `applyStoredPrices`). README, глоссарий (`price_update_skipped`, `PriceChange`, `PriceSkip`). | Отклонения: (1) ответ без `data[]` — пустой список, все модели с `openRouterModel` в `skipped` (D-96). (2) Причины пропуска — английский текст, спека его не задаёт. (3) Трактовка «строка не разбирается»: отсутствующий `completion` и любая строка вне десятичного формата (`1e-7`, `-1`, `""`, `" 0.1 "`) — пропуск с `invalid pricing.<поле>`; `input_cache_read: null` — как отсутствие поля. Не D-n. |
| 2026-10-30 | `spec/004-t9` | T-9 обновление цен из OpenRouter. Пакет `packages/adapter-openrouter` (`createOpenRouterPrices`, `fetchModels(signal)` на `fetch` с `retry` и `httpRetryable` из `@swag/helpers`; `HttpError` с `Retry-After`); тесты на фейковом сервере. Оболочка `apps/llm-gateway`: `assembleCore` (`applyStoredPrices` поверх `models.json`, `createCatalogHolder` вместо статического `catalogPriceBook`), `startLlmGatewayCore` возвращает `holder` и `priceStore`; `src/prices.ts`: `refreshPrices` (запрос → `applyOpenRouterPrices` → `warn price_update_skipped` → `PriceStore.save` с `updatedAt` из `Clock` → подмена каталога → `info price_updated`; сбой запроса — `price_refresh_failed`, сбой `save` — `price_save_failed`) и `startPriceRefresh` (первый цикл после сверки, затем таймер; профиль `test` и интервал 0 — без запросов; `stop` отменяет запрос и таймер). `LlmGatewayConfig`: `LLM_PRICES_REFRESH_MS`, `OPENROUTER_MODELS_URL`, `LLM_PROFILE`. `.env.example` и `.env`. `openRouterModel` в `infra/llm/{dev,prod}/models.json`; тест AC-004-30 в `scripts/repo.test.ts`. Тесты: `apps/llm-gateway/test/prices.test.ts` (AC-004-29, профиль test и 0, `price_save_failed`, ошибка чтения цен на старте), `apps/llm-gateway/test/money-prices-postgres.test.ts` (AC-004-40, гейт `POSTGRES_TEST_URL`). README адаптера, `apps/llm-gateway` (раздел «Обновление цен каталога» переписан), корневой README, глоссарий, `architecture.md`. | Отклонения: (1) таймаут одной попытки запроса к OpenRouter — 10 с, константа в `main.ts` (D-97). (2) `LLM_PROFILE` добавлен в `LlmGatewayConfig` — по 002, 4.9 (REQ-002-12, 4.8–4.9): переменная уже в `.env` и монтирует `models.json`; обязательный enum, без значения по умолчанию. (3) Compose не менялся: `llm-gateway` получает `.env` через `env_file`, новые переменные приходят оттуда. (4) Обновление цен — в оболочке (`src/prices.ts`), как сказано в 4.9; ядро получает только чистую `applyOpenRouterPrices`/`applyStoredPrices`. (5) Тесты оболочки не запускают `main.ts` (top-level await, как у T-6); проверяются `assembleCore`, `startPriceRefresh` и `startLlmGatewayCore`. (6) В `package-lock.json` попутно исправлен дрейф: у `packages/adapter-postgres` в локе не было `@swag/llm-gateway-core`, хотя `package.json` его объявляет. |
| 2026-10-30 | `spec/004-t10` | T-10 оркестратор: порт `LlmSwarms` и `OrchestratorCoreDeps.llmSwarms`; `launch` регистрирует рой после `swarm_exists` и до песочниц (`expiresAt` = часы + `swarmMs` + 60 с, при `swarmMs` 0 — `null`, бюджеты роя и агентов из `SwarmLaunch`), сбой — `swarm.failed` `gateway_unavailable` с `detail`, песочницы не создаются; `finish` вызывает `close` после уборки и `agent.stopped`, до итога, сбой — `warn gateway_close_failed`; `agent.failed` в `running` с `model_error:*_budget_exceeded` → `swarm.failed` `budget_exceeded`, `detail: "<agentId>: <код>"`. Тесты: фейк `LlmSwarms` в `test/orchestrator-core.test.ts` по умолчанию успешен; `describe` с AC-004-21…24 (порядок вызовов, `expiresAt`, четыре итога, сбой close, причины бюджета). README ядра, глоссарий (`gateway_close_failed`). Сломано до T-11: `apps/orchestrator` (`src/main.ts`, `test/health.test.ts` — нет `llmSwarms` в deps). | Отклонения: (1) Фикстуры `launchBody` и тела AC-022-17 получили `budgetMicroUsd` в `SwarmLaunch` (поле обязательно с T-1): 11 тестов ядра падали ещё до T-10 из-за валидации, не из-за регистрации. (2) `close` вызывается и при `gateway_unavailable`, D-98. (3) В `apps/api/test/e2e.test.ts` и `trace.test.ts` добавлен фейк `llmSwarms` в `createOrchestratorCore`, иначе не проходит `tsc`; сами эти тесты падают на `createSwarm` с `400` (нет `budgetMicroUsd` в запросе, как и в T-1), чинит T-13. (4) Лог при сбое регистрации не добавлен: спека 4.8 его не задаёт, причина уходит в `swarm.failed.detail`. |
| 2026-10-30 | `spec/004-t11` | T-11 адаптер и оболочка. Пакет `packages/adapter-gateway-http`: `createGatewaySwarms({ baseUrl, token, timeoutMs })` на `fetch` — `register` (`POST /internal/swarms`, `Bearer`, успех только `204`), `close` (`POST /internal/swarms/:id/close`, успех `2xx` и `404`), без повторов, таймаут через `AbortSignal.timeout`; `GatewayError` с кодом из тела `{ error: { message, code } }`. Тесты `test/gateway-swarms.test.ts` на фейковом сервере (REQ-004-3). `apps/orchestrator`: `LLM_GATEWAY_URL` в `OrchestratorConfig` (`packages/config`), `createGatewaySwarms` в `main.ts`, фейк `llmSwarms` в `test/health.test.ts`, `compose.yaml` (`LLM_GATEWAY_URL` в `orchestrator`; `depends_on: llm-gateway` уже был), `.env.example` и `.env`. README пакета, оболочки, `packages/config`, `orchestrator-core`, `architecture.md`; пакет в корневом `tsconfig.json` и `apps/orchestrator/tsconfig.json`. | Отклонения: (1) Для ответа без JSON-тела или без `error.code` код ошибки — `http_<статус>`; спека кода в таком случае не задаёт. (2) Таймаут 10 с — константа `GATEWAY_TIMEOUT_MS` в `main.ts`, D-99. |
| 2026-10-30 | `spec/004-t12` | T-12 `adapter-openai`: тест AC-004-25 в `test/chat-model.test.ts` (`it.each` на `402 swarm_budget_exceeded` и `403 caller_not_registered`; заглушка `stubGateway` теперь считает запросы; `maxRetries: 2`, ожидание — один запрос). Код адаптера не менялся: `openai` 7.33.0 (`package-lock.json`) не повторяет 402 и 403, `shouldRetry` повторяет только 408, 409, 429, 5xx и при `x-should-retry: true`; правка не нужна. README: строка про повторы, тест AC-004-25, ссылка на 004 4.12. Проверки: `packages/adapter-openai` 12 из 12 зелёные, eslint и prettier чистые, `tsc -p tsconfig.dev.json` — только ошибка api-core:205. | Отклонение: «Готово, когда: `npm run check` зелёный на фича-ветке» на этом этапе невыполнимо. `typecheck` падает на `packages/api-core/src/index.ts:205` (`createSwarm` без `budgetMicroUsd`, как в T-1); тесты `api` и UI падают на обязательном бюджете (T-1). Их чинят T-13 и T-15; проверка `npm run check` переносится на завершение группы. |
| 2026-10-30 | `spec/004-t13` | T-13 деньги в api и проекции роя. `api-core`: `ApiCoreDeps.limits.maxBudgetMicroUsd`; `createSwarm` проверяет бюджет роя по пределу и бюджет агента по бюджету роя (`validation_error` с текстами 4.7), бюджеты идут в `swarm.created` и `SwarmLaunch`. `api-integration`: `budgetMicroUsd` и `spentMicroUsd` в `SwarmView` и агентах, `swarm.created` задаёт бюджеты, `llm.call` прибавляет `charge.microUsd` (без `charge` — `costMicroUsd ?? 0`) роя и агента. `packages/config`: `SWARM_MAX_BUDGET_MICRO_USD` в `ApiConfig`; `apps/api` передаёт его в ядро; `.env.example`, `.env`, `compose.yaml` (сервис `api`). Тесты: AC-004-2 (`api-core`, три теста), AC-004-26 и AC-004-3 (`api-integration`, с проверкой проекции без полей денег), тест переменной в `config`; тела запросов тестов `api-core`, `apps/api` получили бюджет, фикстуры лимита — `maxBudgetMicroUsd`; AC-004-19 (`apps/llm-gateway/test/money-postgres.test.ts`) сверяет `spentMicroUsd` с `projectSwarm` (D-95 закрыт; `@swag/api-integration` в `devDependencies` `apps/llm-gateway`, в `package-lock.json` добавлена только эта запись). README пакетов и оболочек, глоссарий. | Отклонения: (1) `compose.yaml`: в 4.11 переменная не перечислена для compose, но без неё `ApiConfig` в контейнере `api` не разбирается, поэтому добавлена в сервис `api`. (2) Порядок проверок `createSwarm`: бюджет раньше лимита активных роёв, D-100. (3) Расход после итогового статуса роя учитывается, отсутствующее поле проекции до 004 читается как 0, D-101. (4) Тесты 001/003 (`api-core`, `apps/api`) получили `budgetMicroUsd` в телах и `maxBudgetMicroUsd` в лимитах: минимальная правка, как в T-1. (5) Тест `apps/llm-gateway/test/stack.test.ts` (AC-002-20, AC-002-21) не проходит без поднятого стека (`LLM_GATEWAY_URL` задан, контейнеры не запущены): падал и до T-13, не относится к этой задаче. |
| 2026-10-30 | `spec/004-t14` | T-14 `ui-core`: `formatUsd` (4 знака, округление вверх, целочисленно), `usdToMicro`, `spentLastMinute` (окно `(nowMs − 60000, nowMs]`), `formatSwarmMoney` по таблице 4.8; `formatLlmCall` по 4.8: сумма из `charge`, `≈` при `basis: estimate`, без `charge` — как в 002. Тесты AC-004-27: `test/money-format.test.ts` (`it.each` по таблицам 4.8, граница окна, `usdToMicro('0.50')`), строки `formatLlmCall` в `test/format-llm-call.test.ts`. README ui-core. Глоссарий уже содержал имена из 4.8. | Отклонения: (1) `usdToMicro` принимает строку, как в AC-004-27, некорректный ввод даёт `NaN`, D-103. (2) `spentLastMinute` для событий без `charge` берёт `costMicroUsd ?? 0`, как в 4.7, D-104. (3) В `test/ui-core.test.ts` фикстуры `createSwarm` получили `budgetMicroUsd` (обязательный бюджет с T-1); тесты падали до этой задачи. (4) Третья строка таблицы `formatSwarmMoney` задаёт только остаток; в тесте проверяется вся строка, собранная по тем же правилам. |
| 2026-10-30 | `spec/004-t15` | T-15 `apps/ui/cabinet`: поле «Бюджет, $» в форме роя (по умолчанию `0.50`) и «Бюджет агента, $» (пустое — `null`); строка денег над графом (`formatSwarmMoney`, `spentLastMinute`), таймер `MONEY_TICK_MS` 5 с (очищается в `ngOnDestroy`), список агентов с `formatUsd`; тексты причин `budget_exceeded` и `gateway_unavailable` в шапке ошибки и в ленте. Логика перенесена в `ui-core` (`packages/ui-core/src/index.ts`): `agentBudgetMicro`, `swarmFormInput`, `failureReasonText`, тип `AgentInput`, тесты `packages/ui-core/test/money-input.test.ts` (перевод, проверка через `SwarmCreateRequest`, тексты причин). Новые имена в глоссарии: `AgentInput`, `agentBudgetMicro`, `swarmFormInput`, `failureReasonText`, `MONEY_TICK_MS`. Проверки: `vitest packages/ui-core` 60/60, `npm run build -w @swag/cabinet` — успех (`ng build`, bundle generation 1.867 с, повторный прогон 4 с), `tsc -p tsconfig.dev.json`, eslint, prettier, `arch:check` чисто. README cabinet и ui-core. | Отклонения: (1) в cabinet нет тестов: Angular-тестового раннера в проекте нет, компоненты не покрыты тестами; проверка сборкой `ng build` и ручная проверка UI — в T-20. (2) Превышение бюджета агента над бюджетом роя форма не проверяет: `SwarmCreateRequest` этого не требует, это проверка `api-core` (4.7), ответ `400` выводится ошибкой формы (D-105). (3) Список агентов на странице роя — новый элемент; 4.8 говорит «у агента в списке», а списка не было (D-106). (4) Тексты для причин, кроме двух из 4.8, не добавлялись (D-107). (5) Решение по D-103: поле отдаёт строку, `usdToMicro` получает её напрямую; `NaN` отсекает `SwarmCreateRequest`, сообщение — от zod на английском, как у прочих полей формы. |
| 2026-10-30 | `spec/004-t16` | T-16 `scripts/money-report.ts`: `parseMoneyReportArgs` (`--swarm` — uuid, `--since` — дата, неизвестный аргумент или пустое значение — сообщение и код 1), `formatMoneyReport(LedgerReport)` — три строки 4.13, `formatUsd` из `ui-core`; `DATABASE_URL` — через `loadConfig(LlmGatewayConfig.pick)`, пул закрывается в `finally`. Скрипт не запускается при импорте (`import.meta.url` сверяется с `argv[1]`). Корневой `package.json`: `money:report`. Тест `scripts/money-report.test.ts` на Postgres (схема на файл, миграции `runMigrations`): `AC-004-32` — два роя, базисы usage/estimate/none, вызовы без факта, фильтр `since`, пустой рой; `REQ-004-19` — разбор аргументов. README: команда в таблице, пункт в «Проверка» с примером. Глоссарий: `formatMoneyReport`, `parseMoneyReportArgs`. Проверки: `vitest scripts/money-report.test.ts packages/adapter-postgres` 22 зелёных, 2 пропущены (бенчмарки без `POSTGRES_BENCH`), `tsc -p tsconfig.dev.json`, eslint, prettier чисто. Ручной прогон: `npm run money:report` на `.env` без подмены переменных (адрес `postgres` → `127.0.0.1` через `onHost`, как в `db:migrate`); после `db:migrate` — `calls 0 · charged $0.0000 (usage 0, estimate 0, none 0)` / `provider $0.0000 по 0 вызовам · без факта 0` / `charged vs provider по тем же вызовам: $0.0000 vs $0.0000 · n/a`; с `--swarm <нулевой uuid> --since 2026-10-30` — то же. | Отклонения: (1) 4.13 описывает формат только для непустого ledger и правило `n/a` только для разницы; при нулевом факте сумма провайдера печатается `$0.0000`, `n/a` — только в строке разницы (D-108). (2) 4.13 не задаёт поведение при ошибке ввода; сделано по образцу `llm-ping`: сообщение и код 1 (D-109). |
