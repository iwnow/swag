---
id: "031"
title: Лимит ответа агента
status: in-progress
roadmap_stage: 4
depends_on: ["004"]
superseded_by: null
updated: 2026-10-30
---

# 031. Лимит ответа агента

> **Коротко.**
>
> - **Что появится.** В форме роя можно задать лимит ответа модели (`max_tokens`) для всего роя и отдельно для любого агента. Пустое поле — значение по умолчанию.
> - **Чьё значение берётся.** Сначала значение агента, если его нет — значение роя, если нет и его — `AGENT_MAX_TOKENS` оркестратора (сейчас `8192`).
> - **Где проверяется.** Предел сверху задаёт `api` из новой переменной `AGENT_MAX_TOKENS_LIMIT` (Q-1). Больше предела — `400 validation_error`, рой не создаётся.
> - **Что не меняется.** Gateway уже резервирует деньги по `max_tokens` вызова (004, 4.3). Больший лимит даёт больший резерв: при маленьком бюджете вызов получит `402`, и рой упадёт с `budget_exceeded`, как сейчас.
> - **Что нужно от человека.** Ничего: Q-1 и Q-2 решены 2026-10-30, спека `ready` по решению человека.

## 1. Контекст и цель

Роадмап, этап 4 «Деньги роя»: расходы роя под контролем пользователя. Решение человека от 2026-10-30, при приёмке 004 T-20: 2048 токенов не хватало reasoning-моделям, общее умолчание подняли до 8192, а своё значение на рой и агента вынесли в эту спеку.

Сейчас `AGENT_MAX_TOKENS` одно на всех: оркестратор кладёт его в env каждой песочницы (`orchestrator-core`, `agentSpec`), агент шлёт его в `max_tokens` каждого вызова. Поменять лимит можно только переменной окружения и перезапуском.

После спеки лимит задаётся при создании роя: на рой и на агента. Агенту с длинными ответами или reasoning-моделью можно дать больше, короткому — меньше и тем уменьшить резерв в gateway.

## 2. Объём

**Входит:**

- поле `maxTokens` в `AgentDraft` и `SwarmCreateRequest`, перенос в `swarm.created` и `SwarmLaunch`;
- предел `AGENT_MAX_TOKENS_LIMIT` в `api` и проверка в `createSwarm`;
- выбор значения агента в оркестраторе: агент → рой → `AGENT_MAX_TOKENS`;
- поля «Лимит ответа, токенов» для роя и для агента в форме роя, функции `ui-core`;
- тексты спек 022 (4.8) и README затронутых пакетов.

**Не входит** (агент это не делает, даже если кажется логичным):

- показ лимита на странице роя и в `SwarmView`;
- изменение лимита у роя, который уже запущен;
- выключение или ограничение reasoning у моделей — D-111, спека профилей моделей;
- лимит выхода из каталога моделей (`maxOutputTokens`) и проверка лимита по модели;
- верхний предел `max_tokens` в gateway: gateway проверяет только `≥ 1` (004, 4.3);
- изменение `AGENT_MAX_STEPS` и самопроверки агента (N-18);
- выбор лимита координатором — спека 027.

## 3. Требования

| ID | Требование | Приоритет |
|---|---|---|
| REQ-031-1 | `AgentDraft` и `SwarmCreateRequest` MUST принимать необязательное поле `maxTokens`: целое от 1 до 1 000 000 или `null`, по умолчанию `null`. | MUST |
| REQ-031-2 | `createSwarm` MUST отклонить запрос `validation_error` с сообщением `max_tokens exceeds AGENT_MAX_TOKENS_LIMIT`, если `maxTokens` роя или любого агента больше `AGENT_MAX_TOKENS_LIMIT`; события `swarm.created` при этом нет. | MUST |
| REQ-031-3 | `maxTokens` роя и агентов MUST попадать в `swarm.created` и в `SwarmLaunch` без изменений. | MUST |
| REQ-031-4 | Оркестратор MUST передавать в песочницу агента `AGENT_MAX_TOKENS` = `maxTokens` агента, иначе `maxTokens` роя, иначе `AGENT_MAX_TOKENS` из своей конфигурации. | MUST |
| REQ-031-5 | Форма роя MUST давать поле «Лимит ответа, токенов» для роя и для каждого агента. Пустое поле MUST уходить как `null`, нечисловое — не проходить `validateForm`. | MUST |
| REQ-031-6 | Рой, созданный без `maxTokens`, MUST работать как до спеки: события без поля читаются, агенты получают `AGENT_MAX_TOKENS` оркестратора. | MUST |

## 4. Контракты

### 4.1. `@swag/contracts`

`llm.ts`:

```ts
export const MaxTokens = z.number().int().min(1).max(1_000_000); // рабочий предел — AGENT_MAX_TOKENS_LIMIT (4.3)
```

`swarm.ts`:

```ts
export const AgentDraft = z.strictObject({
  name: z.string().trim().min(1).max(40),
  role: z.string().trim().min(1).max(500),
  model: PlatformModel.default('chat-small'),
  budgetMicroUsd: BudgetMicroUsd.nullable().default(null),
  maxTokens: MaxTokens.nullable().default(null), // null — значение роя (031, 4.4)
});

export const SwarmCreateRequest = z.strictObject({
  task: z.string().trim().min(1).max(4000),
  budgetMicroUsd: BudgetMicroUsd,
  maxTokens: MaxTokens.nullable().default(null), // null — AGENT_MAX_TOKENS оркестратора
  agents: z.array(AgentDraft).min(1).max(8),
});

export const SwarmLaunch = z.strictObject({
  swarmId: SwarmId,
  task: z.string(),
  budgetMicroUsd: BudgetMicroUsd,
  maxTokens: MaxTokens.nullable(),
  agents: z.array(AgentSpec).min(1),
});
```

`AgentSpec` выводится из `AgentDraft` и получает `maxTokens` сам.

`events.ts`, `swarm.created.data`: до спеки 031 поля нет, поэтому оно необязательное и в рое, и в агенте:

```ts
data: z.strictObject({
  task: z.string(),
  budgetMicroUsd: BudgetMicroUsd.optional(),
  maxTokens: MaxTokens.nullable().optional(),
  agents: z.array(AgentSpec.partial({ budgetMicroUsd: true, maxTokens: true })),
}),
```

### 4.2. Env

| Переменная | Где | Значение | Назначение |
|---|---|---|---|
| `AGENT_MAX_TOKENS_LIMIT` | `ApiConfig` | целое ≥ 1, `.env.example`: `65536` | предел `maxTokens` роя и агента (Q-1) |

`compose.yaml`: сервис `api` получает `AGENT_MAX_TOKENS_LIMIT: ${AGENT_MAX_TOKENS_LIMIT}`. Локальный `.env` — то же значение. `AGENT_MAX_TOKENS` оркестратора и агента не меняется.

### 4.3. `api-core`

```ts
limits: { maxActiveSwarms: number; maxBudgetMicroUsd: number; maxTokens: number }; // maxTokens — AGENT_MAX_TOKENS_LIMIT (031, 4.2)
```

`apps/api/src/main.ts` передаёт `maxTokens: config.AGENT_MAX_TOKENS_LIMIT`.

Порядок проверок `createSwarm`: схема → бюджеты (004, 4.7) → `maxTokens` → `MAX_ACTIVE_SWARMS`. Проверка `maxTokens`: значение роя или любого агента, не `null` и больше `limits.maxTokens`, → `fail('validation_error', 'max_tokens exceeds AGENT_MAX_TOKENS_LIMIT')`.

`swarm.created.data` и `orchestrator.launch` получают `maxTokens` роя, агенты — со своим `maxTokens` из черновика.

### 4.4. `orchestrator-core`

В `agentSpec` (env песочницы):

```ts
AGENT_MAX_TOKENS: String(agent.maxTokens ?? run.launch.maxTokens ?? deps.agent.maxTokens),
```

Остальной env не меняется. Регистрация роя в gateway (`LlmSwarmRegistration`) не меняется: gateway берёт `max_tokens` из тела вызова.

### 4.5. `ui-core`

```ts
// Спека 031, 4.5: пустое поле — null (значение по умолчанию), иначе целое; нечисловое — NaN, его отсекает validateForm.
export function maxTokensInput(text: string): number | null;

export interface AgentInput {
  name: string;
  role: string;
  model: PlatformModel;
  budget: string;
  maxTokens: string; // «Лимит ответа, токенов»: пустое — значение роя
}

export function swarmFormInput(
  task: string,
  budget: string,
  maxTokens: string, // «Лимит ответа, токенов» роя: пустое — AGENT_MAX_TOKENS
  agents: AgentInput[],
): unknown;
```

`maxTokensInput`: `text.trim()` пустой → `null`; строка из одних цифр → `Number(text)`; иначе `NaN`. `swarmFormInput` кладёт `maxTokensInput(maxTokens)` в `maxTokens` роя и `maxTokensInput(agent.maxTokens)` в `maxTokens` каждого агента.

### 4.6. Форма роя (`apps/ui/cabinet`, `swarm-new.page.ts`)

- Поле роя рядом с «Бюджет, $»: `<input type="number" min="1" step="1">`, подпись и `aria-label` «Лимит ответа, токенов», по умолчанию пусто, `placeholder` «по умолчанию».
- Поле агента после «Бюджет агента, $»: `placeholder` и `aria-label` «Лимит ответа, токенов», по умолчанию пусто.
- `newAgent()` возвращает `maxTokens: ''`. `submit()` передаёт значение роя в `swarmFormInput` третьим аргументом.
- Ошибка `400` от сервера выводится, как остальные ошибки формы (004, 4.8).

## 5. Критерии приёмки

- **AC-031-1** — *Given* `SwarmCreateRequest` с `maxTokens` у роя и у агента. *When* разбор схемой. *Then* `16384` и `null` проходят, отсутствие поля даёт `null`, `0`, `1.5`, `"100"` и `1_000_001` отклоняются. Тест: `packages/contracts/test/swarm.test.ts`.
- **AC-031-2** — *Given* `limits.maxTokens = 65536`. *When* `createSwarm` с `maxTokens` роя `65537` или с одним агентом `65537`. *Then* `validation_error` с сообщением `max_tokens exceeds AGENT_MAX_TOKENS_LIMIT`, `orchestrator.launch` не вызван, `swarm.created` нет. Ровно `65536` проходит. Тест: `packages/api-core/test/api-core.test.ts`.
- **AC-031-3** — *Given* запрос с `maxTokens` роя `4096` и агентами `16384` и без поля. *When* `createSwarm`. *Then* `swarm.created.data` и аргумент `orchestrator.launch` содержат `maxTokens: 4096` у роя и `16384`, `null` у агентов. Тест: `packages/api-core/test/api-core.test.ts`.
- **AC-031-4** — *Given* `deps.agent.maxTokens = 8192` и `SwarmLaunch` с тремя агентами. *When* оркестратор создаёт песочницы. *Then* `AGENT_MAX_TOKENS` в env: `16384` у агента со своим значением, `4096` у агента без него при `maxTokens` роя `4096`, `8192` при `maxTokens` роя `null`. Тест: `packages/orchestrator-core/test/orchestrator-core.test.ts`.
- **AC-031-5** — *Given* `swarmFormInput` с лимитом роя `''` и агентами `'16384'` и `''`. *When* вызов. *Then* `maxTokens` роя `null`, агентов `16384` и `null`; лимит `'abc'` даёт `NaN`, и `validateForm` возвращает ошибку. Тест: `packages/ui-core/test/money-input.test.ts`.
- **AC-031-6** — *Given* событие `swarm.created` без `maxTokens` (запись до спеки). *When* разбор схемой события и проекция роя. *Then* событие разбирается, рой отображается как раньше. Тест: `packages/contracts/test/swarm.test.ts`.
- **AC-031-7** `[manual]` — *Given* стек на профиле `test`. *When* в форме роя у агента «Лимит ответа, токенов» `1024`, у роя пусто, рой создан. *Then* в теле запроса `POST /api/swarms` у агента `maxTokens: 1024`, у роя `null`; `docker inspect` песочницы агента показывает `AGENT_MAX_TOKENS=1024`, у второго агента без значения — `8192`. Проверка: DevTools браузера и `docker inspect`, результат — в журнал.

## 6. Нефункциональные требования

Новых нет: проверка в `createSwarm` и выбор значения в оркестраторе — сравнения без ввода-вывода.

## 7. Безопасность: что не должно сломаться

- Рой без `maxTokens` получает прежний `AGENT_MAX_TOKENS` → AC-031-4 (третий агент), AC-031-6.
- Огромный лимит не проходит мимо `api` → AC-031-1 (предел схемы), AC-031-2 (предел `AGENT_MAX_TOKENS_LIMIT`).
- Больший лимит не обходит бюджет: резерв gateway по `max_tokens` (004, REQ-004-8) не меняется и закрыт тестами 004.
- Ключи провайдеров в песочницу не попадают: env песочницы меняется только в значении `AGENT_MAX_TOKENS` → AC-031-4.

## 8. Задачи для агента

Выполняются по порядку. После каждой задачи — коммит.

- [x] **T-1.** `@swag/contracts`: `MaxTokens` в `llm.ts`, `maxTokens` в `AgentDraft`, `SwarmCreateRequest`, `SwarmLaunch` (`swarm.ts`) и `swarm.created` (`events.ts`) по 4.1; тесты в `test/swarm.test.ts`; README пакета; `MaxTokens` в глоссарий уже внесён. Закрывает: REQ-031-1, REQ-031-6, AC-031-1, AC-031-6. Готово, когда: тесты пакета и `npm run typecheck` зелёные. Ломает `api-core` и `orchestrator-core` по типам (`SwarmLaunch.maxTokens` обязателен), поэтому T-1…T-4 идут через фича-ветку `spec/031-max-tokens`, `npm run check` зелёный только после T-4.
- [x] **T-2.** `@swag/config`: `AGENT_MAX_TOKENS_LIMIT` в `ApiConfig` (`z.coerce.number().int().min(1)`); `.env.example` и локальный `.env` — `AGENT_MAX_TOKENS_LIMIT=65536`; `compose.yaml` — переменная у `api`; `apps/api/src/main.ts` — `limits.maxTokens`. README `config` и `api`. Закрывает: REQ-031-2 (конфигурация). Готово, когда: `npm run typecheck` по `config` и `api` зелёный.
- [x] **T-3.** `@swag/api-core`: `limits.maxTokens`, проверка и перенос `maxTokens` в `createSwarm` по 4.3; тесты в `test/api-core.test.ts`; README. Закрывает: REQ-031-2, REQ-031-3, AC-031-2, AC-031-3. Готово, когда: тесты пакета зелёные.
- [x] **T-4.** `@swag/orchestrator-core`: `AGENT_MAX_TOKENS` в `agentSpec` по 4.4; тест на три агента; README. Закрывает: REQ-031-4, AC-031-4. Готово, когда: тесты пакета зелёные, `npm run check` зелёный (конец фича-ветки).
- [ ] **T-5.** `@swag/ui-core`: `maxTokensInput`, поле `maxTokens` в `AgentInput`, третий аргумент `swarmFormInput` по 4.5; тесты; README. Ломает `apps/ui/cabinet` по сигнатуре — T-5 и T-6 одним этапом. Закрывает: REQ-031-5, AC-031-5. Готово, когда: тесты пакета зелёные.
- [ ] **T-6.** `apps/ui/cabinet/src/app/swarm-new.page.ts`: поля роя и агента по 4.6; README `cabinet`. Закрывает: REQ-031-5. Готово, когда: `npm run check` зелёный.
- [ ] **T-7.** Тексты спек: строка `AGENT_MAX_TOKENS` в таблице 4.8 спеки 022 — источник «значение агента, роя или `AGENT_MAX_TOKENS` оркестратора (031, 4.4)», строка в журнале 022; ручная проверка AC-031-7, результат в журнал 031. Закрывает: AC-031-7. Готово, когда: `npm run spec:check` зелёный.

## 9. Открытые вопросы

Все вопросы решены.

- [x] **Q-1.** Предел `maxTokens` и где его хранить. (а) Переменная `AGENT_MAX_TOKENS_LIMIT` в `api`, `65536` в `.env.example`, плюс жёсткий предел схемы `1 000 000`. (б) Только предел схемы, без переменной. (в) Предел по модели из каталога (`maxOutputTokens`) — нужна доработка каталога и цен. **Рекомендация: (а)** — так же устроен `SWARM_MAX_BUDGET_MICRO_USD` (004, 4.11), предел меняется без релиза; `65536` покрывает выход моделей `chat-small` и `chat-large` в профиле `prod`. Вариант (в) — в спеке профилей моделей. *(Claude, 2026-10-30)* **Ответ (человек, 2026-10-30):** (а).
- [x] **Q-2.** Проверять ли при создании роя, что резерв одного вызова помещается в бюджет. Пример: агент с `maxTokens` 65536 на `chat-large` и бюджетом $0.01 упадёт на первом вызове с `402` и рой — с `budget_exceeded`. (а) Не проверять: gateway уже отказывает до вызова модели, деньги не тратятся, причина видна в рое. (б) Проверять в `api`: нужны цены моделей в `api` (сейчас они только в gateway). (в) Подсказка в форме без запрета. **Рекомендация: (а)** — (б) тянет цены в `api` и дублирует проверку gateway, а ошибка понятна по причине `budget_exceeded`. *(Claude, 2026-10-30)* **Ответ (человек, 2026-10-30):** (а).

## 10. Журнал реализации

Заполняет агент.

| Дата | Ветка / коммит | Что сделано | Отклонения от спеки |
|---|---|---|---|
| 2026-10-30 | spec/031-t1 / T-1 | Контракты: `MaxTokens`, `maxTokens` в `AgentDraft`, `SwarmCreateRequest`, `SwarmLaunch`, `swarm.created`; тесты AC-031-1, AC-031-6 | — |
| 2026-10-30 | spec/031-t1 / T-2 | `AGENT_MAX_TOKENS_LIMIT` в `ApiConfig`, `.env.example`, `compose.yaml`, `main.ts` → `limits.maxTokens`; тесты config обновлены фикстурой | api typecheck зелёный только после T-3 (api-core `limits.maxTokens`) |
| 2026-10-30 | spec/031-t1 / T-3 | `limits.maxTokens`, проверка `max_tokens exceeds AGENT_MAX_TOKENS_LIMIT` в `createSwarm`, перенос в `swarm.created` и `SwarmLaunch`; тесты AC-031-2, AC-031-3 | — |
| 2026-10-30 | spec/031-t1 / T-4 | `AGENT_MAX_TOKENS` в `agentSpec`: агент → рой → `deps.agent.maxTokens`; тесты AC-031-4; фикстуры `maxTokens: null` | — |
