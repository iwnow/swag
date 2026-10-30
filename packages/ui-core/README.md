# @swag/ui-core

Ядро фронтендов платформы: валидация формы роя, открытие страницы роя с состоянием из событий, переподключение потока. Чистый TypeScript, без Angular и DOM: фронтенд передаёт реализации портов.

## Задачи

- `validateForm(input)` — проверка формы схемой `SwarmCreateRequest` с путями полей.
- `createSwarm(input)` — валидация, затем `SwarmsApi.create`.
- `listSwarms()` — список роёв.
- `openSwarm(id)` — страница роя: `view` строится через `applyEvent` из `@swag/api-integration`, `feed` — список принятых событий; при обрыве потока переподключение с `after = lastSeq` через паузу (1 с по умолчанию); повторные события не попадают в ленту.
- `SwarmPage.stop()` — остановка через `SwarmsApi.stop`; `close()` — закрыть поток и отменить переподключение.
- `traceUrl(traceId)` — адрес трейса события в Grafana по шаблону из зависимостей; без `traceId` — `null` (спека 016, 4.10).
- `formatLlmCall(data)` — строка события `llm.call` для ленты роя: модель, токены с кэшем, стоимость в долларах (6 знаков), статус `прерван` или `ошибка <код>`; при `usage: null` — `без usage`, при оценке из `charge` (`basis: estimate`) — `≈$…` (спека 002, 4.11; изменено 004, 4.8). Сумма — `charge.microUsd`, без `charge` — `costMicroUsd`. Чистая функция вне `createUiCore`: фронтенд вызывает её напрямую.
- `formatUsd(microUsd)` — сумма в долларах, 4 знака, округление вверх (`$0.0124`); целочисленная арифметика (спека 004, 4.8).
- `usdToMicro(usd)` — строка поля «Бюджет, $» → micro-USD (`Math.round(usd × 10⁶)`, `'0.50'` → `500000`); некорректный ввод даёт `NaN` (спека 004, 4.8).
- `agentBudgetMicro(budget)` — поле «Бюджет агента, $»: пустая строка → `null` (бюджета нет), иначе `usdToMicro`.
- `maxTokensInput(text)` — поле «Лимит ответа, токенов»: пустое → `null` (значение по умолчанию), одни цифры → число, иначе `NaN`; `NaN` отсекает `SwarmCreateRequest` (спека 031, 4.5).
- `swarmFormInput(task, budget, maxTokens, agents)` — вход формы роя (доллары и токены строками) → поля `SwarmCreateRequest`: `budgetMicroUsd` и `maxTokens` роя, у агентов `budgetMicroUsd` и `maxTokens`. Тип агента — `AgentInput` (поле `maxTokens` — 031, 4.5). Проверку делает `validateForm`/`SwarmCreateRequest`, функция только переводит.
- `failureReasonText(reason)` — текст причины `swarm.failed`: `budget_exceeded` → «бюджет исчерпан», `gateway_unavailable` → «шлюз моделей недоступен»; прочие причины — как пришли (спека 004, 4.8).
- `spentLastMinute(events, nowMs)` — сумма `llm.call` с `ts` в `(nowMs − 60000, nowMs]`.
- `formatSwarmMoney(view, lastMinuteMicroUsd)` — строка панели роя: потрачено, бюджет, остаток, расход за минуту; без бюджета — `бюджет —` (спека 004, 4.8).
- `formatAgentStep(data)` — строка `agent.step` в ленте роя: `шаг N`, текст ответа через `: ` (если не `null`), имена инструментов через `→` (спека 022, 4.10). Тип `data` — `AgentStepData`, выведен из `@swag/contracts`.
- `unreadMessageIds(feed, status)` — id событий `bus.message`, на которые получатель не начал ход (нет `agent.working` с тем же `messageId`); пусто, пока рой не в `completed`, `failed`, `stopped` (спека 030, 4.4). Чистая функция вне `createUiCore`.
- Форма: модель агента — поле `AgentDraft.model`; без выбора схема `SwarmCreateRequest` в `validateForm` подставляет `chat-small`, в `SwarmsApi.create` уходит она.

## Что внутри сейчас

- `src/index.ts` — `createUiCore`, порты `SwarmsApi`, `EventStream`, `Timers`, зависимость `traces: { urlTemplate }`, функции `formatLlmCall`, `formatAgentStep`, `unreadMessageIds`, `formatUsd`, `usdToMicro`, `spentLastMinute`, `formatSwarmMoney`, `agentBudgetMicro`, `maxTokensInput`, `swarmFormInput`, `failureReasonText`.
- `test/ui-core.test.ts` — AC-001-23, AC-016-14, AC-022-23, AC-031-6 (проекция `swarm.created` без `maxTokens`).
- `test/format-llm-call.test.ts` — AC-002-24, AC-004-27 (строки `formatLlmCall` из 4.8).
- `test/money-format.test.ts` — AC-004-27 (`formatUsd`, `usdToMicro`, `spentLastMinute`, `formatSwarmMoney`, строки таблиц 4.8, граница окна 60 с).
- `test/money-input.test.ts` — перевод полей формы (`agentBudgetMicro`, `swarmFormInput`), проверка результата через `SwarmCreateRequest`, тексты причин `failureReasonText` (спека 004, 4.8; T-15); AC-031-5 — лимит ответа роя и агента, `abc` → `NaN` и ошибка `validateForm` (спека 031, T-5).
- `test/format-agent-step.test.ts` — AC-022-23.
- `test/unread-message-ids.test.ts` — AC-030-7.

## Ключевые решения

- Порты, а не `fetch`/`WebSocket` в ядре: адаптеры живут в `apps/ui/cabinet/src/app/api.ts` (T-12, T-13).
- Переподключение: `onError` от потока → `Timers.setTimeout` → `open(id, lastSeq)`; защита от повторов — проверкой `event.seq <= view.lastSeq` до `applyEvent`; событие, не подходящее к состоянию, пропускается.
- Модель формы роя не дублируется: список моделей UI берёт из `PlatformModel.options` контракта, форма валидируется `SwarmCreateRequest`, значение по умолчанию — из схемы (`chat-small`).
- Зависимости (`package.json`): `@swag/contracts`, `@swag/api-integration`, `zod`; в исходниках `zod` напрямую не импортируется. Белый список ядра — REQ-001-18.
- Непрочитанное (030) вычисляется из уже существующих событий: `bus.message` и `agent.working` с тем же `messageId`; новых событий платформы нет, проекция роя не меняется.
- Деньги: целые micro-USD, без `Number`-деления там, где важна точность. `formatUsd` округляет вверх до 4 знаков, остаток в `formatSwarmMoney` — вниз до 4 знаков (остаток не завышается). `formatLlmCall` — 6 знаков, точно, без округления. Окно `spentLastMinute`: `ts > nowMs − 60000` и `ts ≤ nowMs` (событие ровно на `nowMs − 60000` не входит) (спека 004, 4.8).
- `traceUrl`: шаблон с подстановкой `{traceId}` приходит от фронтенда (`traces.urlTemplate`, обязательная зависимость), ядро не знает адреса Grafana. `traceId` подставляется через `encodeURIComponent` (для hex — без изменений), заменяются все вхождения `{traceId}`.

## Ограничения

Правила ядра ([архитектура](../../docs/architecture.md), [спека 000, 4.2](../../docs/spec/000-foundation.md#42-правила-ядра-и-оболочки)): нет окружения, DOM и инфраструктуры; всё внешнее — через порты.

## Связи

- Фронтенд: `apps/ui/cabinet` (`@swag/cabinet`).
- Использует: `@swag/contracts`, `@swag/api-integration`.

## Спеки

- 001 — 4.8, REQ-001-13.
- 016 — 4.10, REQ-016-13, AC-016-14.
- 014 — деление `ui-core` по фронтендам (D-11).
- 002 — 4.11, REQ-002-15, AC-002-24.
- 022 — 4.1 (`PlatformModel`, `AgentDraft.model`), 4.10, REQ-022-15, AC-022-23.
- 030 — 4.4, REQ-030-6, AC-030-7.
- 031 — 4.5, REQ-031-5, AC-031-5: `maxTokensInput` — пустое поле → `null`, нечисловое → `NaN`, которое отсекает схема (проверка предела — в `api`, не в форме).
- 004 — 4.8, AC-004-27 (`formatUsd`, `usdToMicro`, `spentLastMinute`, `formatSwarmMoney`, `formatLlmCall` с `charge`); T-15 (`agentBudgetMicro`, `swarmFormInput`, `failureReasonText`, тесты `money-input`).
