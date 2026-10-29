---
id: "030"
title: Диалог агентов роя
status: review
roadmap_stage: 2
depends_on: ["022"]
superseded_by: null
updated: 2026-10-29
---

# 030. Диалог агентов роя

> **Коротко.** Агенты роя начинают по-настоящему переписываться: отправив сообщение, агент ждёт ответа, а не продолжает разговор за собеседника.
> - **Что появится.**
>   - Инструмент может уступить ход: успешный `send_message` завершает ход агента (`agent.idle`), ответ участника приходит следующим ходом с его текстом в истории.
>   - В ленте UI сообщение, которое получатель так и не начал обрабатывать к концу роя, помечено «не прочитано».
>   - Вызов модели, оборванный клиентом (песочницу удалили при завершении роя), пишется в `llm.call` как `aborted`, а не как `error` `upstream_error`.
> - **Откуда.** Разбор ленты роя `65f50542` на `dev`, 2026-10-29: `agent-1` отправил стих `agent-2` и в том же ходе «прочитал ответ», которого не получал, — разобрал собственную строку как чужую; ответ `agent-2` (#15) и два сообщения `agent-1` (#18, #21) не прочитал никто; после `agent.result` в ленте `llm.call` `agent-2` с `upstream_error`.
> - **Ключевые решения.** Ожидание ответа — в агентном цикле, общим флагом инструмента `yieldTurn`: цикл по-прежнему не знает о рое. Непрочитанное вычисляется в `ui-core` из уже существующих событий (`bus.message` и `agent.working` с тем же `messageId`), новых событий нет.
> - **Меняет спеку 022:** контракты 4.2 (`ToolOutcome`, `AgentLoopResult`), 4.4 (шаг 6), 4.5 (результат `send_message`) и AC-022-13. **Меняет 002:** 4.4 — обрыв клиентом обычного вызова.
> - **Из бэклога:** N-13 → T-6.
> - **Что нужно от человека:** Q-1 решён (вариант «а»); 022 принята; поставить `ready`.

## 1. Контекст и цель

Роадмап, этап 2 «Агенты думают», [«Агент»](../../AI_PLATFORM_ROADMAP.md#агент): агенты роя решают задачу вместе, общаясь через шину. Спека 022 сделала цикл и инструменты, сценарий [S-3](scenarios.md#s-3-рой-с-llm-решает-задачу-вместе) проходит по букве, но совместной работы нет.

Сейчас (022, 4.2) после `send_message` цикл сразу вызывает модель снова: результат инструмента `ok: отправлено agent-2` модель понимает как «ответ уже есть» и сочиняет его сама. Ответ участника встаёт в очередь агента (обработчик подписки последовательный, REQ-022-14) и ждёт конца хода, а ход заканчивается `finish` — после него входящие отбрасываются (REQ-022-8). При уборке роя оркестратор удаляет песочницы, вызов модели, который в этот момент шёл, обрывается, и gateway записывает его как сбой провайдера: в обычном (не потоковом) вызове обрыв сигнала клиента превращается в `network` → `upstream_error`.

Цель: отправив сообщение, агент заканчивает ход и продолжает только по ответу; в ленте видно, какие сообщения так и не были прочитаны; оборванный клиентом вызов модели не выглядит сбоем провайдера.

## 2. Объём

**Входит:**
- `packages/agent-core`: флаг `yieldTurn` в `ToolOutcome`, итог цикла `yielded`, `send_message` уступает ход, `yielded` → `agent.idle`;
- `packages/ui-core`: функция непрочитанных сообщений; `apps/ui/cabinet`: отметка в ленте;
- `packages/llm-gateway-core`, `packages/adapter-litellm`: обрыв клиентом обычного вызова → `llm.call` `aborted`;
- сквозной тест диалога в `apps/api` и зависимости теста (из N-13);
- правка текстов 022 и 002 по этой спеке, глоссарий, README пакетов; шаг 8 сценария S-3 (уже в черновике).

**Не входит** (агент это не делает, даже если кажется логичным):
- стоимость `$0.000000` у `chat-small` на `dev` — не ошибка: в `infra/llm/dev/models.json` цена `chat-small` (`openrouter/openrouter/free`) равна 0; обновление цен — N-9, спека 004;
- запрет или задержка `finish`, пока агент-вход ждёт ответов, — решается в Q-1; без решения поведение `finish` не меняется;
- доставка входящих сообщений внутрь идущего хода (между шагами цикла);
- ожидание оркестратором конца идущих вызовов модели перед удалением песочниц; мягкая остановка агентов;
- новые события платформы (`agent.message_dropped` и т. п.) и изменение проекции роя `SwarmView`;
- сбой публикации посреди хода (N-11), `agent.failed` в `waiting` (N-12), модели `dev` и `max_tokens` (N-14) — в своих спеках;
- изменение потокового пути gateway: там обрыв клиентом уже `aborted` (002, 4.4).

## 3. Требования

| ID | Требование | Приоритет |
|---|---|---|
| REQ-030-1 | Если после исполнения всех `tool_calls` шага хотя бы один инструмент вернул `yieldTurn: true` и ни один не вернул `stop`, `runAgentLoop` MUST вернуть итог `yielded` без следующего вызова модели; сообщения `role: tool` всех вызовов шага MUST быть в `messages`. | MUST |
| REQ-030-2 | `stop` MUST иметь приоритет над `yieldTurn`: шаг с обоими флагами даёт `stopped`. | MUST |
| REQ-030-3 | `send_message` MUST возвращать `yieldTurn: true` только при успешной отправке; при ошибке аргументов — результат без `yieldTurn` (модель может исправиться в том же ходе). | MUST |
| REQ-030-4 | Агент роя MUST публиковать `agent.idle` по итогу `yielded`; напоминание агенту-входу (022, 4.4, шаг 5) по итогу `yielded` MUST NOT применяться. | MUST |
| REQ-030-5 | Ответ участника, пришедший во время хода, MUST обрабатываться отдельным ходом после текущего, и его текст MUST быть во входе модели этого хода. | MUST |
| REQ-030-6 | Лента роя в UI MUST помечать «не прочитано» каждое `bus.message`, для которого в ленте нет `agent.working` с тем же `messageId`, когда рой в конечном статусе (`completed`, `failed`, `stopped`). Пока рой не в конечном статусе, отметки нет. | MUST |
| REQ-030-7 | Если обычный (не потоковый) вызов модели в gateway не удался, а сигнал клиента к этому моменту оборван, gateway MUST публиковать `llm.call` со `status: 'aborted'` без `errorCode`, а не `status: 'error'`. Таймаут и отказ провайдера без обрыва клиента классифицируются как раньше. | MUST |

## 4. Контракты

### 4.1. Агентный цикл — `packages/agent-core/src/loop.ts`

```ts
// yieldTurn — инструмент уступает ход: цикл заканчивается после этого шага (030, REQ-030-1).
export type ToolOutcome = { content: string; stop?: { result: string }; yieldTurn?: true };

export type AgentLoopResult = { messages: ChatMessage[]; steps: number } & (
  | { kind: 'text'; text: string | null }
  | { kind: 'stopped'; result: string }
  | { kind: 'yielded' }
  | { kind: 'max_steps' }
  | { kind: 'model_error'; error: { code: ChatModelErrorCode; message: string } }
);
```

Конец шага с `tool_calls` (после записи всех `role: tool` в порядке `tool_calls`):
1. есть `stop` — `stopped` с `result` первого `stop` (как в 022);
2. иначе есть `yieldTurn` — `yielded`;
3. иначе — следующий вызов модели (как в 022).

### 4.2. `send_message` — `packages/agent-core/src/prompt.ts`

| Исход | `content` | `yieldTurn` |
|---|---|---|
| успех | `ok: отправлено {to}. Ответ придёт отдельным сообщением.` | `true` |
| ошибка аргументов | `error: <path>: <message>` (как в 022) | нет |

`finish` не меняется.

### 4.3. Агент роя — `packages/agent-core/src/index.ts`

Алгоритм хода 022, 4.4: шаг 5 срабатывает только на `kind: text` (без изменений); в шаге 6 добавляется `yielded` → `agent.idle`. `awaiting` по-прежнему пополняется при отправке и очищается входящим от участника.

### 4.4. Непрочитанные сообщения — `packages/ui-core`

```ts
// id событий bus.message, которые получатель не начал обрабатывать; пусто, пока рой не в конечном статусе (030, REQ-030-6).
export function unreadMessageIds(feed: readonly PlatformEvent[], status: SwarmStatus): ReadonlySet<string>;
```

- результат — множество `event.id` событий `bus.message`;
- сообщение прочитано, если в `feed` есть `agent.working` с `data.messageId === bus.message.data.messageId`;
- `status` не `completed`, `failed`, `stopped` → пустое множество.

`apps/ui/cabinet/src/app/swarm.page.ts`: у строки `bus.message` из множества после текста — ` · не прочитано` (отдельный `span`, стиль приглушённого текста ленты).

### 4.5. Gateway — обрыв клиентом обычного вызова

`packages/llm-gateway-core/src/index.ts`:

```ts
export type UpstreamResponse =
  | { ok: true; body: unknown }
  | { ok: false; failure: UpstreamFailure | { kind: 'aborted' } }; // aborted — внешний signal (клиент ушёл)
```

В `complete` при `failure.kind === 'aborted'`: `llm.call` с `status: 'aborted'`, `usage: null`, `costMicroUsd: null`, `providerCostMicroUsd: null`, без `errorCode`; лог `llm call` уровня `info`; ответ клиенту — как при `{ kind: 'network' }` (502 `upstream_error`), клиент его не получает. Остальные `failure` — `upstreamFailed`, как в 002.

`packages/adapter-litellm/src/index.ts`, `complete`: при отказе (до заголовков или при чтении тела) — `{ kind: 'aborted' }`, если внешний `signal.aborted`; иначе прежняя классификация (`timeout` по таймеру простоя, `network`, `http`). Правило то же, что у `streamFailure`.

### 4.6. Глоссарий

Добавлено в [glossary.md](glossary.md) вместе с черновиком:

| Термин | В коде | Определение |
|---|---|---|
| Уступить ход | `yieldTurn`, итог `yielded` | Флаг результата инструмента: цикл заканчивается после шага, агент ждёт следующего сообщения (030, 4.1). |
| Непрочитанное сообщение | `unreadMessageIds` | `bus.message`, для которого к концу роя нет `agent.working` с тем же `messageId` (030, 4.4). |

## 5. Критерии приёмки

- **AC-030-1** — *Given* скриптовый `ChatModel`: шаг 1 — вызов инструмента, который возвращает `yieldTurn: true`, *When* `runAgentLoop`, *Then* `kind: yielded`, `steps: 1`, модель вызвана один раз, `messages` = `[input, assistant, tool]`.
- **AC-030-2** — *Given* шаг с двумя `tool_calls`: один инструмент возвращает `yieldTurn`, другой — `stop`, *When* `runAgentLoop`, *Then* `kind: stopped`, оба инструмента исполнены, `role: tool` в порядке `tool_calls`.
- **AC-030-3** — *Given* шаг с двумя `tool_calls`: `yieldTurn` и обычный результат, *When* `runAgentLoop`, *Then* `kind: yielded`, два сообщения `role: tool` в порядке `tool_calls`, второго вызова модели нет.
- **AC-030-4** — *Given* `swarmTools` агента с участником `agent-2`, *When* `send_message` с `{to:'agent-2', text:'x'}` и с `{to:'agent-9', text:'x'}`, *Then* первый: `content` по 4.2, `yieldTurn: true`, колбэк отправки вызван; второй: `error: …`, без `yieldTurn`, колбэк не вызван.
- **AC-030-5** — *Given* `agent-core` агента-входа со скриптовой моделью (ход 1: `send_message` к `agent-2`; ход 2: `finish`), *When* задача от `user`, затем сообщение от `agent-2`, *Then* ход 1: `agent.working`, один `agent.step`, `BusMessage` к `agent-2`, `agent.idle`, модель вызвана один раз, напоминания нет; ход 2: `agent.working` с `messageId` сообщения `agent-2`, последний вход модели — `Сообщение от agent-2 «…»:\n<текст>`, `agent.result`.
- **AC-030-6** — *Given* сквозной тест `apps/api` (как AC-022-21): `agent-1` — `send_message` к `agent-2`, после ответа — `finish`; `agent-2` — `send_message` к `agent-1`, *When* `createSwarm`, *Then* рой `completed`; `bus.message` `agent-2 → agent-1` в ленте раньше `agent.working` `agent-1` с его `messageId`; `unreadMessageIds(лента, 'completed')` пусто.
- **AC-030-7** — *Given* лента: `bus.message` A и B, `agent.working` с `messageId` A, *When* `unreadMessageIds` со статусом `completed`, `failed`, `stopped`, *Then* `{B}`; со статусом `running` — пусто.
- **AC-030-8** — *Given* `llm-gateway-core` с апстримом, который возвращает `{ ok: false, failure: { kind: 'aborted' } }`, *When* `complete`, *Then* `llm.call` со `status: 'aborted'`, `usage: null`, без `errorCode`; с `{ kind: 'network' }` — по-прежнему `status: 'error'`, `errorCode: 'upstream_error'`.
- **AC-030-9** — *Given* `createLiteLlmUpstream` с подставным `fetch`, который ждёт сигнала, *When* `complete` и внешний `signal` оборван, *Then* `failure: { kind: 'aborted' }`; *When* сработал таймер простоя — `timeout`; *When* `fetch` отклонён без обрыва — `network`.
- **AC-030-10** `[manual]` — *Given* `npm run up` с `LLM_PROFILE=test`, рой из `agent-1` и `agent-2`, задача-скрипт `__tool_calls__`: `agent-1` в одном шаге вызывает `send_message` к `agent-2` и `finish` (строку собирает `JSON.stringify`, пример — в журнал), *When* рой `completed`, *Then* в UI отметка «не прочитано» стоит ровно у тех `bus.message`, для которых в ленте нет `agent.working` с их `messageId`; пока рой шёл, отметок не было. Проверка: текст ленты в журнал.
- **AC-030-11** `[manual]` — *Given* сценарий S-3 на `LLM_PROFILE=dev` (из S-3), *When* три прогона, *Then* в каждом, где `agent-1` писал `agent-2`: после `bus.message` `agent-1 → agent-2` у `agent-1` `agent.idle`, ответ `agent-2` обработан ходом `agent-1` (`agent.working` с его `messageId`), «не прочитано» нет у сообщений к `agent-1`; `llm.call` после `agent.result` — только `ok` или `aborted`. Проверка: текст ленты и итог прогонов в журнал.

## 6. Нефункциональные требования

Новых нет. NFR-022-1 (`npm test` < 60 с) должен выполняться.

## 7. Безопасность: что не должно сломаться

- `finish` по-прежнему завершает цикл без следующего вызова модели и имеет приоритет → AC-030-2, AC-022-5.
- Ограничения `send_message` (не себе, не `user`, только участникам) → AC-022-14, AC-030-4.
- Лимит шагов `maxSteps` на всю жизнь агента → тесты AC-022 на `max_steps` без изменений.
- Тексты сообщений не попадают в логи и спаны → AC-022-24 без изменений; новых логов с текстом нет.
- Успешные вызовы и отказы провайдера в gateway публикуются как в 002 → AC-030-8, тесты 002.

## 8. Задачи для агента

Выполняются по порядку. После каждой задачи — коммит.

- [x] **T-1.** `packages/agent-core/src/loop.ts` и его тест: `yieldTurn`, итог `yielded` по 4.1. Закрывает: REQ-030-1, REQ-030-2, AC-030-1…3. Готово, когда: тесты AC-030-1…3 и все прежние тесты `loop` зелёные.
- [x] **T-2.** `packages/agent-core/src/prompt.ts` и его тест: результат `send_message` по 4.2. Закрывает: REQ-030-3, AC-030-4. Готово, когда: тест AC-030-4 зелёный, AC-022-14 зелёный.
- [x] **T-3.** `packages/agent-core/src/index.ts` и его тест: `yielded` → `agent.idle` по 4.3; тест AC-030-5; тест AC-022-13 переписан под один `agent.step` на ход (`stepIndex` 1 и 2). Закрывает: REQ-030-4, REQ-030-5, AC-030-5. Готово, когда: тесты `agent-core` зелёные; README `agent-core` — раздел про ход агента.
- [x] **T-4.** `packages/ui-core`: `unreadMessageIds` по 4.4 и тест AC-030-7; экспорт из индекса. Закрывает: REQ-030-6, AC-030-7. Готово, когда: тест зелёный, README `ui-core` обновлён.
- [x] **T-5.** `apps/ui/cabinet/src/app/swarm.page.ts` (и его шаблон): отметка «не прочитано» по 4.4. Закрывает: REQ-030-6. Готово, когда: `npm run build` зелёный, README кабинета обновлён. Ручная проверка — в T-9.
- [x] **T-6.** `apps/api/test/e2e.test.ts`: тест AC-030-6; `apps/api/package.json` — `@swag/agent-core`, `@swag/orchestrator-core` и `@swag/ui-core` в `devDependencies`, при необходимости `references` в tsconfig (из N-13). Закрывает: REQ-030-5, AC-030-6. Готово, когда: тест зелёный, `npm run arch:check` зелёный.
- [x] **T-7.** `packages/llm-gateway-core/src/index.ts` и его тест: `UpstreamResponse` с `aborted`, публикация по 4.5. Закрывает: REQ-030-7, AC-030-8. Готово, когда: тесты gateway зелёные, README `llm-gateway-core` обновлён.
- [x] **T-8.** `packages/adapter-litellm/src/index.ts` и его тест: `complete` возвращает `aborted` по 4.5. Закрывает: REQ-030-7, AC-030-9. Готово, когда: тест AC-030-9 и прежние тесты адаптера зелёные, README адаптера обновлён.
- [x] **T-9.** Тексты и ручные проверки: 022 — 4.2, 4.4 (шаг 6), 4.5 (таблица инструментов), AC-022-13; 002 — 4.4 (обычный вызов, обрыв клиентом); пометка «изменено спекой 030», запись в журналы 022 и 002; глоссарий — строки «Итог цикла» и «Инструмент агента» дополнить `yielded` и `yieldTurn` (новые строки 4.6 уже добавлены); ручные AC-030-10, AC-030-11; `npm run check`. Закрывает: AC-030-10, AC-030-11. Готово, когда: проверки в журнале, `npm run check` зелёный, статус `review`.

## 9. Открытые вопросы

Пока список не пуст, спека не может быть `ready`.

- [x] **Q-1. `finish` агента-входа, пока он ждёт ответов участников.** *(Claude, 2026-10-29)*
  **Решение (человек, 2026-10-29): а** — `finish` разрешён при любом `awaiting`, поведение 022 не меняется; непрочитанные ответы видны в ленте (REQ-030-6).
  После T-1…T-3 агент-вход, отправив сообщение, уходит в `agent.idle` и вызывает `finish` уже по ответу. Но в одном шаге модель может вызвать `send_message` и `finish` вместе, или вызвать `finish`, пока ждёт ответа другого участника: ответ тогда отбрасывается (`agent_finished`) и в ленте будет «не прочитано».
  - **а)** разрешать, как сейчас: `finish` — решение модели; непрочитанное видно в ленте. Риска зависания нет.
  - **б)** отказывать: при непустом `awaiting` `finish` возвращает `error: ждёшь ответа от <id>`, модель должна дождаться. Риск: участник не ответит — рой висит до `SWARM_TIMEOUT_MS`.
  - **в)** откладывать: `finish` при непустом `awaiting` запоминается, рой завершается по последнему ответу без нового вызова модели. Сложнее, а ответы модель так и не увидит.

  Рекомендация — **а**: после `yieldTurn` такой случай редок, лента его показывает, а б и в меняют завершение роя (REQ-022-11) ради редкого случая.

## 10. Журнал реализации

Заполняет агент.

| Дата | Ветка / коммит | Что сделано | Отклонения от спеки |
|---|---|---|---|
| 2026-10-29 | `spec/030-t1`, PR #75 / `464b56d` | T-1–T-3: `ToolOutcome.yieldTurn`, итог цикла `yielded` (stop важнее yieldTurn), `send_message` уступает ход с текстом `ok: отправлено {to}. Ответ придёт отдельным сообщением.`, по `yielded` — `agent.idle`. Тесты `apps/agent` и `apps/api` переведены на уступку хода: подставной шлюз отвечает только `send_message`, `team()` в e2e — без ответа после `send_message` | AC-022-28 «после напоминания»: при непустом ожидании ветка напоминания после `send_message` недостижима, тест проверяет уступку хода вместо напоминания — заметка N-16 |
| 2026-10-29 | `spec/030-t4`, PR #76 / `4ac391e` | T-4, T-5: `unreadMessageIds(feed, status)` в `ui-core`, отметка « · не прочитано» в ленте кабинета | — |
| 2026-10-29 | `spec/030-t7`, PR #77 / `24a531b` | T-7, T-8: обрыв клиентом обычного вызова — `llm.call` со статусом `aborted` и `info`-логом в `llm-gateway-core`; адаптер LiteLLM отдаёт `aborted` (`transportFailure`, `withoutAborted`), тест оболочки gateway «клиент ушёл» ждёт `aborted` без `errorCode` | Спека 030 заменила трактовку D-58 (обрыв клиентом — `upstream_error`) на `aborted` по REQ-030-7 |
| 2026-10-29 | `spec/030-t6`, PR #78 / `bf1c2aa` | T-6: сквозной тест диалога агентов (AC-030-6) в `apps/api` | — |
| 2026-10-29 | `spec/030-t9` | T-9: тексты 022 (4.2, 4.4, 4.5, AC-022-13), 002 (4.4) и глоссарий; ручные AC-030-10, AC-030-11 | В 002 исправлен и 4.5 (адаптер: обрыв клиентом — `aborted`), хотя «Меняет 002» называет только 4.4: без правки 4.5 противоречил бы 4.4 и коду T-8 |

**AC-030-10** (`LLM_PROFILE=test`, `npm run up`). Задача роя собрана `JSON.stringify` — `agent-1` в одном шаге шлёт `agent-2` и вызывает `finish`, `agent-2` по тексту сообщения отвечает `agent-1`:

```
__tool_calls__[{"name":"send_message","arguments":{"to":"agent-2","text":"ответ агенту-1 __tool_calls__[{\"name\":\"send_message\",\"arguments\":{\"to\":\"agent-1\",\"text\":\"ответ агента-2\"}}]"}},{"name":"finish","arguments":{"result":"итог роя"}}]
```

Рой `1ba61f22-8630-4c6a-b84d-02c1a0804bbf`, `completed`. Лента (отметка — как в UI):

```
#6  bus.message user→agent-1            mid=fb8f91bc
#8  agent.working agent-1               mid=fb8f91bc
#9  llm.call agent-1 ok
#10 agent.step agent-1
#11 bus.message agent-1→agent-2         mid=03fde3ea
#12 agent.result agent-1
#13 agent.working agent-2               mid=03fde3ea
#14 llm.call agent-2 ok
#15 agent.step agent-2
#16 bus.message agent-2→agent-1 · не прочитано   mid=8c7a6bd5
#17 agent.idle agent-2
#18 agent.stopped agent-1
#19 agent.stopped agent-2
#20 swarm.completed
```

«Не прочитано» — только у #16: у #6 и #11 есть `agent.working` (#8, #13). Пока шёл рой `714a6bfa-4a7d-4ad0-b162-1be784e89914` (статус «работает», лента до #18 `agent.idle`), отметок в UI не было; затем рой остановлен. Результат: пройдено.

**AC-030-11** (`LLM_PROFILE=dev`, S-3: «четверостишие про осень», «Автор» и «Редактор» на `chat-small`), три прогона:

```
прогон 1 fc563692-…: swarm_timeout
#11 bus.message agent-1→agent-2 mid=69cc1d1d
#12 agent.idle agent-1
#13 agent.working agent-2 mid=69cc1d1d
#16 bus.message agent-2→agent-1 mid=a8a7a176
#17 agent.idle agent-2
#18 agent.working agent-1 mid=a8a7a176
#21 bus.message agent-1→agent-2 mid=44d3fc04
#22 agent.idle agent-1
#23 agent.working agent-2 mid=44d3fc04
#25 agent.step agent-2 2 (без инструментов)
#26 agent.idle agent-2
#29 swarm.failed swarm_timeout
непрочитано: нет

прогон 2 6a40d0d5-…: agent-1 — agent.failed model_error:max_tokens на первом шаге, agent-2 не писал

прогон 3 e453b605-…: swarm_timeout
#11 bus.message agent-1→agent-2 mid=ce962d1f
#12 agent.idle agent-1
#13 agent.working agent-2 mid=ce962d1f
#15 agent.step agent-2 1 (без инструментов)
#16 agent.idle agent-2
#19 swarm.failed swarm_timeout
непрочитано: нет
```

В прогонах 1 и 3, где `agent-1` писал `agent-2`: после каждого такого `bus.message` у `agent-1` — `agent.idle`; ответ `agent-2` (прогон 1, #16) обработан ходом `agent-1` (#18 с его `messageId`); непрочитанных сообщений нет. Ни один прогон не дошёл до `agent.result`: бесплатные модели заканчивали шаг `agent-2` без инструментов, рой падал по `swarm_timeout`, — поэтому условие «`llm.call` после `agent.result` — только `ok` или `aborted`» на живых моделях не проверено; путь `aborted` закрыт тестами AC-030-8 и AC-030-9. Результат: пройдено в проверяемой части, итог роёв — не 030 (поведение моделей).
