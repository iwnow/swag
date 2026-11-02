# @swag/node-sdk

SDK для авторов узлов: определение узла на TypeScript через `defineNode`, выгрузка манифеста `NodeManifest` через `toManifest` (спека 021, 4.3). Узел описывает схемы настроек, входа, выхода и операций на Zod; обработчики получают типы из этих схем. Код SDK не зависит от платформы: `api` его не импортирует, манифест читается из `swag-node.json` пакета.

## Задачи

- `defineNode(definition)` — определение узла с перегрузкой на каждый вид (`trigger`, `channel`, `connector`, `program`, `llm-agent` / `human`): настройки в `execute` и `poll` типизированы схемой `settings`, вход и выход — схемами `inputs` / `outputs` и операций.
- `toManifest(definition)` — `NodeManifest` из определения: схемы переводятся в JSON Schema 2020-12, пустые `credentials` и `egress` заполняются `[]`, результат проверяется `NodeManifest.parse`.
- `NodeContext` — то, что видит код узла: `settings`, `secrets.get`, `http.fetch` в пределах `egress`, `log`, `state`, `signal`. Реализацию на платформе даёт спека 026.
- `NodeError` — ошибка узла с кодом из `NodeErrorCode`.
- `@swag/node-sdk/testing` — тестовая обвязка без платформы: `createTestContext` (контекст с проверкой настроек, секретов и `egress`), `runNode`, `runOperation`, `runPoll`, `runSend` (вход и выход проверяются схемами определения, ошибки — `NodeError`).

## Что внутри сейчас

- `src/index.ts` — типы определений (`TriggerDefinition`, `ChannelDefinition`, `ConnectorDefinition`, `OperationDefinition`, `ProgramDefinition`, `BuiltinDefinition`, `NodeDefinition`), `SettingsOf`, `PollResult`, `NodeContext`, `NodeError`, `defineNode`, `toManifest`.
- `test/manifest.test.ts` — AC-021-10: манифест коннектора с двумя операциями (порядок, `access`, `$schema`, `required` у `default`), `credentials` и `egress` по умолчанию, `ZodError` у коннектора без операций.
- `test/types.test.ts` — AC-021-23: тип `ctx.settings.prefix` — `string`, присвоение числа и обращение к несуществующему полю входа — ошибки типов (`@ts-expect-error`).
- `src/testing.ts` — `createTestContext`, `TestContext`, `TestContextOptions`, `runNode`, `runOperation`, `runPoll`, `runSend`.
- `test/fixtures.ts` — фикстуры: копия `example/echo`, программа с неверным выходом, коннектор с секретом и `egress`, канал и канал с неверным событием.
- `test/testing.test.ts` — AC-021-11 (echo, вход и настройки), AC-021-12 (выход), AC-021-13 (секреты и `egress`, без сети при отказе), AC-021-14 (канал: `poll`, `send`, состояние).

## Как написать узел

```ts
import { defineNode } from '@swag/node-sdk';
import { z } from 'zod';

export default defineNode({
  type: 'example/echo',
  version: '1.0.0',
  kind: 'program',
  title: 'Эхо',
  description: 'Пример программы.',
  settings: z.strictObject({ prefix: z.string().max(40).default('') }),
  inputs: z.strictObject({ text: z.string().max(4000) }),
  outputs: z.strictObject({ text: z.string() }),
  execute: async ({ text }, ctx) => ({ text: ctx.settings.prefix + text }),
});
```

Выгрузка манифеста: `toManifest(definition)` (команда `nodes:manifest` появится с T-6).

Проверка без платформы:

```ts
import { createTestContext, runNode } from '@swag/node-sdk/testing';
import { echo } from './node.ts';

const ctx = createTestContext(echo, { settings: { prefix: '> ' } });
await runNode(echo, ctx, { text: 'hi' }); // { text: '> hi' }
```

`createTestContext` проверяет настройки по схеме `settings` (ошибка `invalid_settings`). Секрет доступен только из `credentials` определения и только если передан в `secrets` (иначе `secret_not_declared`). `http.fetch` пропускает только `https:` и адреса из `egress`; остальные адреса дают `egress_denied` до вызова `options.fetch`. По умолчанию `fetch` не ходит в сеть и отвечает `501`. Тестовый контекст не принуждает правила на платформе: это обвязка разработчика, принуждение — спека 026.

Правило про `.transform`: в схемах узла не используется `.transform` (и `.pipe`, которые его содержат). JSON Schema, в которую переводится схема, теряет преобразование, и манифест расходится с тем, что проверяет обработчик. Значения по умолчанию — через `.default()`, ограничения — через `.max()`, `.regex()` и т. п.

## Ограничения

- Схемы Zod переводятся в JSON Schema 2020-12 (`z.toJSONSchema`). Схему, которую нельзя выразить в JSON Schema (`z.date()`, `z.custom()`), `toManifest` не выгружает и бросает ошибку.
- Операции коннектора в `defineNode` объявлены как `OperationDefinition<S, any, any>` (спека 021, 4.3): тип входа и выхода конкретной операции проверкой типов не покрывается.
- Вид `llm-agent` и `human` — только описание: кода у них нет, исполняет платформа.

## Связи

- Использует: `@swag/contracts` (`NodeManifest`, `NodeCredential`, `EgressHost`, `NodeTypeName`, `NodeTypeVersion`, `OperationAccess`), `zod`.
- Используют: пакеты узлов `@swag/node-*` (`@swag/node-example` с T-6, `@swag/node-llm-agent` с T-7).
- Не используется ядрами: `api`, `api-core`, `api-integration` читают только `swag-node.json`.

## Ключевые решения

- Перегрузки `defineNode` по виду, а не одна функция с объединением: тип обработчиков выводится из вида без проверок во время выполнения (021, 4.3, REQ-021-7).
- `any` в `NodeDefinition` и в `operations` — только в этих местах, с `eslint-disable` и причиной: союз видов и `Record` операций хранят определения с разными типами схем. Внешне типы определений строгие.
- `toManifest` строит объект и отдаёт его через `NodeManifest.parse`: правила вида (4.1.2, 4.1.3) проверяются контрактом, а не дублируются в SDK (REQ-021-8).
- Выход `z.toJSONSchema` для `outputs` и операций — `io: 'output'`, поэтому поля со значением по умолчанию попадают в `required`; вход и настройки — `io: 'input'`.

## Спеки

- 021 — контракт узла (4.1, 4.3); REQ-021-7, REQ-021-8, REQ-021-9; AC-021-10, AC-021-11…14, AC-021-23.
