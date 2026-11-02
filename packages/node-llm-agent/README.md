# @swag/node-llm-agent

Тип узла `swag/llm-agent@1.0.0` — LLM-агент на модели платформы. Пакет описывает вид `llm-agent` манифестом (спека 021, REQ-021-10): схема настроек — тот же `AgentDraft` из `@swag/contracts`, что у `SwarmCreateRequest`. Кода у узла нет: исполняет агентный цикл платформы.

## Задачи

- Дать каталогу типов узлов (`GET /node-types`, спека 021, 4.8) тип `swag/llm-agent` с настройками роли, модели, бюджета и лимита ответа.
- Держать схему настроек в одном месте: `AgentDraft` в `@swag/contracts`. Манифест выводится из него, а не пишется отдельно.

## Что внутри сейчас

- `src/node.ts` — `export default defineNode({...})`: `type: 'swag/llm-agent'`, `version: '1.0.0'`, `kind: 'llm-agent'`, `settings: AgentDraft`. Входа, выхода, операций, `credentials` и `egress` нет.
- `swag-node.json` — манифест, выгруженный командой `npm run nodes:manifest`. Не править руками.
- `test/node.test.ts` — AC-021-15 (манифест совпадает с определением) и AC-021-9 (набор 4.4: `AgentDraft.safeParse` и `validateSettings` через `createNodeRegistry` дают одинаковый итог).

## Как обновить

1. Изменить `AgentDraft` в `packages/contracts/src/swarm.ts`.
2. Выполнить `npm run nodes:manifest` из корня репозитория.
3. Запустить `npx vitest run packages/node-llm-agent`. Тест AC-021-15 падает, если `swag-node.json` не выгружен после правки схемы.

## Ограничения

- Формат входа и выхода узла — сообщения шины, их задают спеки 022 и 030; схемы рёбер графа — спека 009. В 021 у вида `llm-agent` `inputs` и `outputs` равны `null`.
- Рой по-прежнему создаётся через `SwarmCreateRequest` с массивом `AgentDraft`; замена на узлы — спеки 009 и 017.
- Отличие от `AgentDraft`: `AgentDraft` обрезает пробелы (`z.string().trim()`), JSON Schema этого не умеет. Строка из одних пробелов проходит `validateSettings` (в манифесте `minLength: 1` считает пробелы), но не проходит `AgentDraft`. Набор проверки 4.4 таких строк не содержит. Отличие принято в 021 и описано здесь; на платформе значения настроек перед исполнением проходят `AgentDraft`.

## Связи

- Использует: `@swag/contracts` (`AgentDraft`), `@swag/node-sdk` (`defineNode`, `toManifest`).
- Тесты используют: `@swag/api-integration` (`createNodeRegistry`) — только в `devDependencies`.
- Читает `api` через `swag-node.json` (с T-10/T-11 спеки 021).

## Ключевые решения

- Вид `llm-agent` без кода: `defineNode` с `kind: 'llm-agent'` — `BuiltinDefinition` (021, 4.3).
- Настройки — `AgentDraft` как есть, без копии схемы: единый источник для роя и каталога (021, REQ-021-10).

## Спеки

- 021 — REQ-021-10, REQ-021-12, REQ-021-15; AC-021-9, AC-021-15; 4.4.
