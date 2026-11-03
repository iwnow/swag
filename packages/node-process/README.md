# @swag/node-process

Тип узла `swag/process@1.0.0` — сохранённый процесс организации как шаг графа. Спека 033, 4.4 и REQ-033-17. Настройка одна — `processId` (UUID). Кода исполнения нет: `api` разворачивает узел в узлы дочернего процесса до проверки и исполнения (`expandGraph`), песочница его не видит.

## Задачи

- Дать каталогу типов узлов (`GET /node-types`) тип `swag/process` вида `program` с настройкой `processId`.
- Разрешить ссылку на процесс в графе родителя, не вводя отдельного вида узла.

## Что внутри сейчас

- `src/node.ts` — `export default defineNode({...})`: `type: 'swag/process'`, `version: '1.0.0'`, `kind: 'program'`, `settings: z.strictObject({ processId: z.uuid() })`, `inputs` и `outputs` — `z.unknown()`. `execute` бросает ошибку: узел разворачивает платформа.
- `swag-node.json` — манифест, выгруженный командой `npm run nodes:manifest`. Не править руками.
- `test/node.test.ts` — REQ-033-17: манифест совпадает с определением; пакет загружается через `loadNodePackages` (тип, вид `program`, `packageOf`); `processId` — UUID, лишние поля отклоняются.

## Как обновить

1. Изменить `settings` в `src/node.ts`.
2. Выполнить `npm run nodes:manifest` из корня репозитория.
3. Запустить `npx vitest run packages/node-process`.

## Ограничения

- Проверка, что процесс существует и принадлежит организации родителя, цикл, глубина (`PROCESS_NEST_MAX_DEPTH`) и длина id — в `expandGraph` (`@swag/api-integration`, 4.4), не в схеме узла.
- Бюджет, таймаут и включённость дочернего процесса в узле не участвуют: развёрнутые узлы идут в бюджете родителя.

## Связи

- Использует: `@swag/node-sdk` (`defineNode`), `zod`.
- Тесты используют: `@swag/node-packages` (`loadNodePackages`) — только в `devDependencies`.
- Имя типа — константа `PROCESS_NODE_TYPE` в `@swag/api-integration` (`swag/process@1.0.0`, T-5).

## Ключевые решения

- Вид `program` с `execute`, бросающим ошибку, а не новый вид: узел не исполняется, а разворачивается до исполнения, поэтому вид не влияет на `invokeNode` (033, 4.4).
- `settings` — `z.strictObject`, `processId` — `z.uuid()`: ссылка всегда однозначна (033, 4.4).

## Спеки

- 033 — REQ-033-17; 4.4 (`swag/process`, `expandGraph`); T-3.
