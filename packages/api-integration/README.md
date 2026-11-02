# @swag/api-integration

Общая чистая логика для ядер, которые работают с API платформы: проекция роя из его событий (спека 001, 4.4) и реестр типов узлов (спека 021, 4.2). Используют `api-core` (хранит состояние роя и каталог узлов) и `ui-core` (показывает рой), поэтому правило одно — в одном месте.

## Задачи

- `applyEvent(view, event)` — применить одно событие роя к `SwarmView`: статусы роя и агентов, счётчики сообщений, число шагов, рёбра по фактическим сообщениям, результат и причина ошибки. Событие с `seq` не больше `lastSeq` игнорируется.
- `projectSwarm(events)` — состояние роя из всей последовательности событий.
- Деньги роя и агентов (004, 4.7): бюджеты из `swarm.created`, расход — сумма `charge.microUsd` событий `llm.call` (без `charge` — `costMicroUsd ?? 0`).
- `createNodeRegistry(manifests)` — реестр типов узлов в памяти (021, 4.2): проверка повторов `type@version` и поддержки схем, `list()` — последняя версия каждого типа со списком версий, `get(ref)`, `validateSettings(ref, settings)` — проверка настроек узла по схеме `settings` манифеста, `validate(ref, target, value)` — проверка входа, выхода или операции коннектора по схеме манифеста (026, 4.2).

## Что внутри сейчас

- `src/swarm-view.ts` — тип `SwarmView` (агенты с `model` и `steps`, деньги: `budgetMicroUsd`, `spentMicroUsd`), `applyEvent`, `projectSwarm`, `FINAL_SWARM_STATUSES` (итоговые статусы роя `completed`, `stopped`, `failed`; используются ядром `api-core`), поля владельца `orgId` и `createdBy` (024, 4.3). Правила — спека 022, 4.6 (с 022 заменяют таблицу 4.4 спеки 001 в части `bus.message`, `agent.step`, `agent.idle`).
- `src/node-registry.ts` — `createNodeRegistry`, `NodeRegistry`, `SettingsResult`, `SettingsIssue`, `NodeRegistryError`. `NodeSchemaTarget`, `ValueResult`. Все схемы манифеста (`settings`, `inputs`, `outputs`, входы и выходы операций) компилируются `z.fromJSONSchema` при создании реестра и хранятся в нём.
- `test/swarm-view.test.ts` — AC-001-2 (таблица 4.4 с правками 4.6, рёбра при создании пустые), AC-022-2 (`steps`, рёбра по сообщениям, `bus.message` не меняет статус, `agent.idle` и `done`) и AC-003-7 (итоговый статус роя окончателен).
- `test/node-registry.test.ts` — AC-021-5 (повтор `type@version`), AC-021-6 (схемы, которые `fromJSONSchema` не принимает: внешний `$ref`, `not`, `if/then`), AC-021-7 (`validateSettings`, `get`, `node_type_not_found`), AC-021-8 (`list`, порядок версий), AC-026-2 (`validate`: `invalid_value` с `issues`, `schema_not_found`, `node_type_not_found`, значение после parse). Манифесты — литералы, проходящие `NodeManifest.parse`.

## Правила проекции (022, 4.6)

- `swarm.created` — `edges: []`, агенты с `model` из `AgentSpec` и `steps: 0`.
- `swarm.created` — `orgId` и `createdBy` из `data` (024, 4.3); отсутствующие поля (рой до 024) — `null`.
- `bus.message` — `messagesIn + 1` у `to`; если `from` — агент, то `messagesOut + 1` у него и ребро `from → to` (создаётся с `messages: 1` или увеличивается). Статус агентов не меняет.
- `agent.step` — `steps + 1` у агента.
- `swarm.created` — `budgetMicroUsd` роя и агентов, если поля есть в событии; у событий до 004 полей нет, и в проекции их тоже нет.
- `llm.call` — `spentMicroUsd` роя и агента увеличивается на сумму; расход учитывается и после итогового статуса, статус при этом не меняется (D-101).
- `agent.idle` — статус `idle`, если агент не `done`, `failed`, `stopped`.
- Итоговый статус роя (`completed`, `stopped`, `failed`) окончательный (003, REQ-003-7, 4.3): после него событие двигает только `lastSeq`, статус роя, `result` и `failure` не меняются.

## Реестр типов узлов (021, 4.2)

- При создании: сначала проверяются повторы `type@version` по всему набору, затем схемы по порядку `settings`, `inputs`, `outputs`, операции (`input`, `output`). Первая схема, на которой `z.fromJSONSchema` бросает, — `node_schema_unsupported` с `schema` (`settings`, `inputs`, `outputs`, `operations.<name>.input|output`) и текстом исключения.
- `validateSettings` не бросает: ссылка, которую не принимает `NodeTypeRef`, и неизвестный тип — `node_type_not_found`; ошибки Zod — `invalid_settings` с `issues` (`path` — ключи через точку, корень — `""`). Верные настройки возвращаются после схемы: значения по умолчанию подставлены.
- `validate(ref, target, value)` (026, 4.2) — проверка входа (`inputs`), выхода (`outputs`) или входа/выхода операции коннектора (`place: 'operation'`, `name`, `io`). Неизвестный `ref` — `node_type_not_found`; у вида нет такой схемы (`null` в манифесте или нет операции с таким именем) — `schema_not_found`; значение не по схеме — `invalid_value` с `issues` тем же форматом, что у настроек. Верное значение возвращается после parse (`ok: true, value`).
- `list()` — по одной записи на `type`, версия — последняя по semver (числа `major`, `minor`, `patch`), `versions` — по убыванию, типы — по возрастанию. Итог считается один раз при создании реестра.
- Все операции синхронные: реестр в памяти, источник — манифесты, уже прошедшие `NodeManifest.parse`.

## Ограничения

Правила ядра ([архитектура](../../docs/architecture.md), [спека 000, 4.2](../../docs/spec/000-foundation.md#42-правила-ядра-и-оболочки)):

- Зависимости — только `zod` и `@swag/contracts`. `zod` с 021 используется в `node-registry.ts` (`z.fromJSONSchema`), новых зависимостей нет.
- Нет Node API, `process`, env, файлов, сети.
- Чистые функции: без состояния и побочных эффектов. Реестр — неизменяемое значение после создания.

Нарушения ловит `npm run arch:check` (пакет включён в проверку как ядро, REQ-001-18).

## Связи

- Использует: `@swag/contracts` (типы событий, `NodeManifest`, `NodeTypeRef`, `nodeTypeRef`, `NodeTypeSummary`).
- Используют: `@swag/api-core` (проекция роя; реестр узлов — с T-8 спеки 021), `@swag/ui-core` (с 001 — ui-core появляется в T-12).

## Ключевые решения

- Состояние роя — не хранимая сущность, а свёртка событий: `projectSwarm` = `reduce(applyEvent)`. Так `api` и `ui` получают одинаковый результат из одних и тех же событий (001, 4.4, T-3).
- `applyEvent` возвращает тот же объект при повторном `seq` (идемпотентность по `seq`), бросает ошибку на событие до `swarm.created` и на повторный `swarm.created`.
- Итоговый статус окончателен (003, 4.3), потому что оркестратор шлёт события асинхронно: поздний `swarm.stopped` или `agent.stopped` после `failed` с `api_restarted` (закрытие прерванных роёв при старте API) не должен переписать причину сбоя. Проверка `seq` и `swarm.created` идёт раньше, поэтому повторный `swarm.created` после итогового статуса по-прежнему бросает.
- Зависимость от `zod` объявлена (белый список ядер, REQ-001-18); до 021 прямых импортов `zod` не было. С 021 `zod` нужен для `z.fromJSONSchema` в реестре узлов (021, 4.2).
- `packages/api-integration` проверяется `arch:check` как ядро (T-2, Q-5).
- Владелец (024, 4.3): `orgId` и `createdBy` проецируются только из `swarm.created`; проекция не знает о правах, видимость роя решает `api-core` (024, 4.4). Проекции, сохранённые до 024, читаются с `null` в обоих полях (как поля 004 — D-101).
- Деньги (004, 4.7): поля `budgetMicroUsd` добавляются условно, а не как `undefined` (`exactOptionalPropertyTypes`). Проекция, сохранённая до 004 без `spentMicroUsd`, читается как 0 (D-101), иначе `llm.call` дал бы `NaN`.
- Проверка настроек через `z.fromJSONSchema` без Ajv (021, Q-1): новых зависимостей ядра нет. Схемы, которые он не принимает (внешний `$ref`, `not`, `if/then`, `dependentSchemas`), отсекаются при создании реестра, а не при проверке настроек (REQ-021-4).
- Схемы значений строятся один раз при создании реестра (026, 4.2): `settings`, `inputs`, `outputs`, входы и выходы операций хранятся в записи `type@version`. `validate` и `validateSettings` только вызывают `safeParse` — ни компиляции, ни разбора JSON Schema на каждый вызов нет.
- Один путь проверки для настроек и значений (`checkValue`): ошибки Zod приводятся к `SettingsIssue` одной функцией.
- Повтор `type@version` проверяется по всему набору до компиляции схем, поэтому ошибка дубля не зависит от содержимого схем (REQ-021-4: «повтор — до схем», 4.2).

## Спеки

- 001 — проекция роя ([4.4](../../docs/spec/001-walking-skeleton.md#44-проекция-роя)).
- 003 — окончательный итоговый статус роя (4.3, REQ-003-7, AC-003-7).
- 004 — деньги в проекции (4.7, REQ-004-2, AC-004-3, AC-004-26).
- 021 — реестр типов узлов (4.2, REQ-021-4…6, AC-021-5…8).
- 026 — `validate` и схемы значений (4.2, AC-026-2).
- 022 — правила проекции (4.6).
- 024 — владелец роя в проекции (4.3, REQ-024-4): `orgId`, `createdBy`.
