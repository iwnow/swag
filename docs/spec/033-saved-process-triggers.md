---
id: "033"
title: Сохранённый процесс и запуск по триггеру
status: draft
roadmap_stage: 9
depends_on: ["009", "021", "026", "013", "024"]
superseded_by: null
updated: 2026-11-03
---

# 033. Сохранённый процесс и запуск по триггеру

> **Коротко.**
> - Появляется **процесс** `Process` — сохранённое определение: имя, граф `ProcessGraph`, бюджет и `maxTokens` одной активации, интервал опроса, предел одновременных активаций. Хранится в Postgres отдельно от запусков, CRUD в `api` (`/processes`), включение и выключение. Права `process.read` и `process.manage`, видимость — как у роёв.
> - В графе процесса разрешён один узел-**триггер** (`kind: 'trigger'`), он же `entry`, с одним исходящим `flow`. Включённый процесс опрашивается: `poll(cursor)` триггера через оркестратор (026), курсор хранится у процесса и сдвигается в одной транзакции с постановкой событий в очередь.
> - Встроенный триггер **`swag/schedule@1.0.0`** — интервал (`everySec`) или cron (`cron` + `timezone`). Его исполняет `api` сам, без песочницы: событие `{ scheduledAt, firedAt }`. Пропущенные срабатывания не копятся — одно догоняющее.
> - **Активация** — один запуск процесса: каждое событие триггера (или ручной запуск `POST /processes/:id/activations`) становится записью в очереди, а при запуске — **роем** с тем же id: тот же резерв бюджета, события, проекция, страница роя. Триггер в рой не попадает: событие уходит входом шагу, в который ведёт его `flow`. Очередь ограничена (`PROCESS_QUEUE_MAX`), активаций одного процесса одновременно не больше `maxConcurrent`.
> - **Процесс как узел** — тип `swag/process@1.0.0` с настройкой `processId`. Перед проверкой и запуском `api` разворачивает его в узлы дочернего процесса прямо в граф родителя: один рой, общий бюджет и таймаут, глубина вложенности ≤ 3.
> - Планировщик — такт в `api` (`tickProcesses` каждые `PROCESS_TICK_MS`), процессы захватываются арендой в Postgres, поэтому несколько реплик `api` не опрашивают один процесс дважды. Каждый опрос и каждая активация — свой корневой трейс.
> - Блокировка автора выключает его процессы. После 10 ошибок опроса подряд процесс выключается сам (`poll_failed`).
> - **Что нужно от человека:** ответить на Q-1…Q-9. Главные — Q-1 (где живёт планировщик), Q-2 (активация = рой), Q-6 (вложенный процесс разворачивается в граф родителя), Q-5 (библиотека cron).

## 1. Контекст и цель

Роадмап, [«Рой как узел графа»](../../AI_PLATFORM_ROADMAP.md#рой) и [раздел 4 «Граф процесса»](../../AI_PLATFORM_ROADMAP.md#4-граф-процесса), этап 9: определение роя хранится отдельно от активаций, процесс запускается событием триггера, рой спит, пока работы нет, и сам может быть узлом другого процесса. Спека 009 (Q-1, ответ «а») вынесла сюда триггеры, сохранённый процесс и вложенность; Q-3 и Q-10 009 — очередь на сохранённый процесс и `stateKey` `process:<processId>:<nodeId>`.

Сейчас граф живёт только внутри роя: `POST /swarms` с задачей пользователя проверяет и сразу исполняет граф, узлы `trigger` отклоняются (`node_kind_unsupported`). `poll` триггера оркестратор исполнять умеет (`POST /node-invocations`, 026), но его никто не вызывает, курсор хранить негде.

После спеки организация сохраняет процесс с триггером, включает его, и платформа сама запускает процесс по событиям: по расписанию или по `poll` стороннего триггера. Каждая активация — рой со своими событиями, стоимостью и трейсом. Сохранённый процесс можно вставить узлом в граф другого процесса или роя. Бот 018 строится на этом: его триггер канала — тот же опрос, а диалог — слой поверх активаций.

## 2. Объём

**Входит:**
- контракты процесса и активации (`packages/contracts/src/process.ts`), права `process.read`, `process.manage`;
- граф процесса: узел-триггер в `checkGraph` (опция `triggers`), `launchGraph` — граф запуска без триггера;
- процесс-узел `swag/process@1.0.0` и разворачивание `expandGraph`, в том числе в графе `POST /swarms`;
- встроенный триггер `swag/schedule@1.0.0` (пакет `@swag/node-schedule`), порт `CronSchedule` и адаптер на croner;
- `SwarmLaunch.trigger` и `LaunchProgram.stateKey`; исполнение входа от триггера в `orchestrator-core`;
- `processId` в `swarm.created` и `SwarmView`;
- хранилище процессов и активаций: порт `ProcessStore`, адаптеры в памяти и Postgres, миграция `0007_processes.sql`;
- CRUD, включение, выключение, ручная активация и список активаций в `api`;
- такт планировщика: захват процессов арендой, опрос, расписание, очередь, запуск активаций, восстановление после перезапуска;
- выключение процессов заблокированного автора;
- корневой трейс на опрос и на активацию.

**Не входит** (агент это не делает, даже если кажется логичным):
- UI процессов: список, форма, включение, история активаций в кабинете — 017 (редактор графа); активации видны в кабинете как рои;
- проверка графа процесса без сохранения (`POST /graph-checks` с триггером) — 017, вместе с D-182;
- триггер с подпиской `start`/`stop`, вебхуки — 020;
- узел-канал, диалог, экземпляр процесса на диалог, память между активациями, аренда диалога — 018;
- опрос нескольких триггеров одной песочницей, лимит одновременных вызовов узлов — 005 (N-33);
- повтор упавших активаций, дедупликация событий триггера, отложенная повторная попытка при нехватке баланса;
- лимит трат процесса за сутки или месяц, баланс ИИ — 025;
- версии определения процесса и история правок;
- построение процесса координатором — 027;
- слияние потоков, ветвления, маппинг полей — 017/027 (009, Q-6);
- модель трейса долгого диалога — 018 (D-13).

## 3. Требования

| ID | Требование | Приоритет |
|---|---|---|
| REQ-033-1 | `api` MUST хранить процесс отдельно от активаций: определение `ProcessDraft` (4.1), автор, организация, включён ли, курсор триггера, время следующего опроса, последняя ошибка. CRUD — по 4.8. | MUST |
| REQ-033-2 | Сохранение процесса (`POST`, `PUT`) MUST проверять определение: разбор `ProcessDraft`, бюджетные проверки как у роя (`SWARM_MAX_BUDGET_MICRO_USD`, бюджет агента ≤ бюджета активации, `AGENT_MAX_TOKENS_LIMIT`), граф — `checkGraph` с `triggers: true`, разворачивание `expandGraph` и проверка развёрнутого графа, настройки `swag/schedule` (4.5). Замечания графа — `400 invalid_graph` в формате 009, 4.9. | MUST |
| REQ-033-3 | `checkGraph` с `triggers: true` MUST разрешать узлы вида `trigger` по правилам 4.3; без опции (рой) MUST вести себя как в 009. | MUST |
| REQ-033-4 | Включить MUST можно только процесс с триггером (`409 process_no_trigger`); перед включением граф MUST проверяться заново (секреты могли удалить). Выключение пользователем MUST отменять активации в очереди (`cancelled`); идущие рои MUST продолжаться. | MUST |
| REQ-033-5 | Такт планировщика MUST каждые `PROCESS_TICK_MS` захватывать включённые процессы, у которых подошло время, арендой на `PROCESS_LEASE_MS` (4.7): процесс, захваченный одним тактом, MUST NOT опрашиваться другим, пока аренда не снята или не истекла. Следующий такт MUST начинаться после окончания предыдущего. | MUST |
| REQ-033-6 | Опрос стороннего триггера MUST идти через оркестратор (`POST /node-invocations`, 026) со `stateKey = process:<processId>:<triggerNodeId>` и курсором процесса. Успех MUST в одной транзакции ставить по активации на каждое событие в порядке массива, сохранять новый курсор и сбрасывать счётчик ошибок. Ошибка MUST оставлять курсор прежним, записывать `lastError` и увеличивать счётчик. | MUST |
| REQ-033-7 | После `PROCESS_POLL_MAX_FAILURES` ошибок опроса подряд процесс MUST выключаться с причиной `poll_failed`; активации в очереди при этом остаются. | MUST |
| REQ-033-8 | Триггер `swag/schedule@1.0.0` MUST исполняться в `api` без вызова оркестратора: в момент `nextRunAt` ставится одна активация с событием `{ scheduledAt, firedAt }`, следующее время — по интервалу или cron от момента такта (4.5). Пропущенные срабатывания MUST давать одну активацию, а не по одной на каждое. | MUST |
| REQ-033-9 | Пока в очереди процесса `PROCESS_QUEUE_MAX` активаций и больше, такт MUST NOT опрашивать его триггер (курсор не сдвигается, события не теряются), а ручная активация MUST отклоняться `409 queue_full`. | MUST |
| REQ-033-10 | Активации из очереди MUST запускаться по порядку постановки, если у процесса меньше `maxConcurrent` неоконченных роёв и не превышен `MAX_ACTIVE_SWARMS`. Активация MUST запускаться ровно один раз, в том числе при нескольких репликах `api` (статус `launching` по 4.7). | MUST |
| REQ-033-11 | Запуск активации MUST идти тем же путём, что `POST /swarms` (`startSwarm`, 4.9): развернуть граф, проверить его, зарезервировать бюджет активации с баланса организации, опубликовать `swarm.created` с `processId`, вызвать оркестратор. Id роя MUST совпадать с id активации, автор роя — автор процесса. | MUST |
| REQ-033-12 | Нехватка баланса MUST давать активации статус `rejected` с причиной `insufficient_balance`, граф с замечаниями при запуске — `rejected` с причиной `invalid_graph`; процесс при этом остаётся включённым. `too_many_active_swarms` MUST оставлять активацию в очереди. | MUST |
| REQ-033-13 | В рое активации триггера нет: шаг, в который ведёт `flow` триггера, MUST получать событие как вход от id узла-триггера — программа вызовом `execute` с событием, команда сообщением от id триггера с текстом `valueText(event)`. Агент-вход такой команды MUST получать `AGENT_TASK_FROM` = id триггера. | MUST |
| REQ-033-14 | Ручная активация `POST /processes/:id/activations` MUST ставить событие в очередь и для выключенного процесса; событие MUST проверяться по `outputs` триггера, если триггер есть (`400 invalid_event`). | MUST |
| REQ-033-15 | Узел `swag/process@1.0.0` MUST разворачиваться в узлы дочернего процесса по 4.4 перед проверкой и запуском — в графе процесса и в графе `POST /swarms`. Дочерний процесс MUST искаться только в организации родителя. Цикл ссылок, глубина больше `PROCESS_NEST_MAX_DEPTH`, отсутствующий процесс и слишком длинный id развёрнутого узла MUST давать замечания графа. | MUST |
| REQ-033-16 | `stateKey` программы MUST задавать `api` в `LaunchProgram.stateKey`: программа роя — `swarm:<swarmId>:<nodeId>`, программа процесса — `process:<processId>:<nodeId>`, программа из развёрнутого дочернего процесса — `process:<childProcessId>:<id узла в дочернем графе>`. | MUST |
| REQ-033-17 | Процесс, на который ссылается узел `swag/process` другого процесса организации, MUST NOT удаляться (`409 process_in_use`). | MUST |
| REQ-033-18 | Блокировка пользователя MUST выключать его процессы с причиной `author_blocked` и отменять их активации в очереди, в том же обработчике, что останавливает его рои (024). | MUST |
| REQ-033-19 | При старте `api` активации в статусе `launching` MUST получать `launched`, если рой с их id есть, иначе — снова `queued`. | MUST |
| REQ-033-20 | Видимость и права процессов MUST совпадать с правилами роёв (024, 4.4): `user` видит и меняет свои процессы, `admin` — процессы своей организации, `supervisor` только видит все. Чужой процесс — `404`. Активации видны тому, кто видит процесс. | MUST |
| REQ-033-21 | Событие активации MUST храниться только пока активация в очереди (`queued`, `launching`): при переходе в `launched`, `rejected`, `cancelled` поле очищается. Событие и курсор MUST NOT попадать в ответы API (кроме задачи роя `task`), событие, курсор и настройки узлов — в логи. | MUST |
| REQ-033-22 | Каждый опрос триггера и каждый запуск активации MUST идти в своём корневом спане (`process.poll`, `process.activation`) с атрибутом `swag.process`; события роя активации несут `traceId` её спана. | MUST |
| REQ-033-23 | В организации MUST быть не больше `PROCESS_MAX_PER_ORG` процессов (`409 too_many_processes`). | MUST |
| REQ-033-24 | Рой из формы и рой из графа без `swag/process` MUST вести себя как до 033: те же события, `stateKey` программ `swarm:<swarmId>:<nodeId>`. | MUST |

## 4. Контракты

### 4.1. Процесс и активация: `packages/contracts/src/process.ts`

```ts
import { z } from 'zod';
import { ProcessGraph, NodeId } from './graph.ts';
import { NodeTypeRef } from './node.ts';
import { BudgetMicroUsd, MaxTokens, OrgId } from './swarm.ts';

export const ProcessId = z.uuid();
export type ProcessId = z.infer<typeof ProcessId>;

export const PROCESS_POLL_MIN_SEC = 60;
export const PROCESS_MAX_CONCURRENT = 4;

// Определение процесса: тело POST и PUT /processes. Бюджет и maxTokens — на одну активацию.
export const ProcessDraft = z.strictObject({
  name: z.string().trim().min(1).max(100),
  graph: ProcessGraph,
  budgetMicroUsd: BudgetMicroUsd,
  maxTokens: MaxTokens.nullable().default(null),
  pollIntervalSec: z.number().int().min(PROCESS_POLL_MIN_SEC).max(86_400).default(300), // для swag/schedule не используется
  maxConcurrent: z.number().int().min(1).max(PROCESS_MAX_CONCURRENT).default(1),
});
export type ProcessDraft = z.infer<typeof ProcessDraft>;

export const ProcessDisabledReason = z.enum(['user', 'poll_failed', 'author_blocked']);
export type ProcessDisabledReason = z.infer<typeof ProcessDisabledReason>;

export const ProcessError = z.strictObject({
  code: z.string().max(64), // NodeInvocationErrorCode или orchestrator_unavailable
  message: z.string().max(1000),
  at: z.iso.datetime(),
});
export type ProcessError = z.infer<typeof ProcessError>;

export const ProcessView = z.strictObject({
  id: ProcessId,
  orgId: OrgId,
  createdBy: z.uuid(),
  definition: ProcessDraft, // после разбора: с умолчаниями
  trigger: z.strictObject({ nodeId: NodeId, type: NodeTypeRef }).nullable(), // узел вида trigger графа
  enabled: z.boolean(),
  disabledReason: ProcessDisabledReason.nullable(), // null у включённого и у нового
  nextRunAt: z.iso.datetime().nullable(), // null у выключенного
  lastPollAt: z.iso.datetime().nullable(),
  lastError: ProcessError.nullable(),
  consecutiveFailures: z.number().int().min(0),
  queued: z.number().int().min(0), // активаций queued и launching
  running: z.number().int().min(0), // роёв процесса в starting или running
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type ProcessView = z.infer<typeof ProcessView>;

export const ProcessSummary = ProcessView.pick({
  id: true, orgId: true, createdBy: true, trigger: true, enabled: true, disabledReason: true,
  nextRunAt: true, queued: true, running: true, updatedAt: true,
}).extend({ name: z.string() });
export type ProcessSummary = z.infer<typeof ProcessSummary>;

export const ProcessList = z.strictObject({ items: z.array(ProcessSummary) }); // updatedAt по убыванию
export type ProcessList = z.infer<typeof ProcessList>;

export const ActivationStatus = z.enum(['queued', 'launching', 'launched', 'rejected', 'cancelled']);
export type ActivationStatus = z.infer<typeof ActivationStatus>;

export const ActivationRejectReason = z.enum(['insufficient_balance', 'invalid_graph']);
export type ActivationRejectReason = z.infer<typeof ActivationRejectReason>;

export const ActivationSource = z.enum(['trigger', 'manual']);
export type ActivationSource = z.infer<typeof ActivationSource>;

// Тело POST /processes/:id/activations.
export const ActivationRequest = z.strictObject({ event: z.unknown() });
export type ActivationRequest = z.infer<typeof ActivationRequest>;

export const ActivationView = z.strictObject({
  id: z.uuid(), // = swarmId роя после запуска
  processId: ProcessId,
  status: ActivationStatus,
  reason: ActivationRejectReason.nullable(), // только у rejected
  source: ActivationSource,
  createdAt: z.iso.datetime(),
  launchedAt: z.iso.datetime().nullable(),
});
export type ActivationView = z.infer<typeof ActivationView>;

export const ActivationList = z.strictObject({ items: z.array(ActivationView) }); // createdAt по убыванию, не больше 50
export type ActivationList = z.infer<typeof ActivationList>;
```

`index.ts` пакета экспортирует `process.ts`. Права (`access.ts`): `Permission` получает `process.read` и `process.manage`; `ROLE_PERMISSIONS`: `user` и `admin` — оба, `supervisor` — `process.read`.

### 4.2. `SwarmLaunch`, `swarm.created`, `SwarmView`

```ts
// swarm.ts
export const LaunchProgram = z.strictObject({
  id: NodeId,
  type: NodeTypeRef,
  settings: z.record(z.string(), z.unknown()),
  credentials: z.record(z.string(), SecretName),
  stateKey: z.string().min(1).max(200).optional(), // нет — оркестратор берёт swarm:<swarmId>:<id> (как в 009)
});

// Вход шага-входа от триггера активации (REQ-033-13). null — задача пользователя, как в 009.
export const LaunchTrigger = z.strictObject({ nodeId: NodeId, event: z.unknown() });

export const SwarmLaunch = z.strictObject({
  // …поля 009 без изменений…
  trigger: LaunchTrigger.nullable().default(null),
});
```

`stateKey` и `trigger` необязательны, чтобы оркестратор и `api` менялись разными этапами: оркестратор принимает старое тело `api`, а `api` после 033 передаёт оба поля всегда.

`swarm.created.data` (`events.ts`) получает `processId: ProcessId.nullable().optional()`: у роя пользователя `null`, у активации — id процесса. `SwarmView` (`api-integration/src/swarm-view.ts`) получает `processId: string | null` из `swarm.created`; рой без поля — `null`.

### 4.3. Граф процесса: `checkGraph` с триггером и `launchGraph`

```ts
// packages/api-integration/src/process-graph.ts
export interface GraphCheckDeps {
  registry: NodeRegistry;
  secretNames: ReadonlySet<string>;
  triggers?: boolean; // true — граф процесса (033); по умолчанию false — граф роя (009)
}
```

`GraphIssueCode` (`graph.ts`) получает `trigger_not_entry`, `trigger_flow`, `process_not_found`, `process_cycle`, `process_too_deep`, `process_node_id_too_long`, `process_invalid`.

При `triggers: true` узел вида `trigger` в проходе 1 допустим, в проходах 2–5 он **шаг-триггер**: шаг, который даёт значение и не принимает его. Правила сверх 009, 4.4:
- проход 2: настройки и `credentials` проверяются, как у программы;
- проход 4: триггер не `entry` — `trigger_not_entry`, путь `nodes.<i>`. У триггера-входа не ровно одно исходящее `flow` — `trigger_flow`, путь `nodes.<i>`. Ребро `link` с триггером — `link_requires_agents`, как у программы;
- проход 5: `exit` — триггер — `exit_not_step`, путь `exit`.

Без `triggers` узел `trigger` по-прежнему `node_kind_unsupported`.

```ts
// Граф запуска: без триггера и его flow; entry — цель flow триггера. Вход — граф без замечаний checkGraph.
export function launchGraph(graph: ProcessGraph, registry: NodeRegistry): {
  graph: ProcessGraph;
  trigger: { nodeId: NodeId; type: NodeTypeRef; settings: Record<string, unknown>; credentials: Record<string, string> } | null;
};
```

Без триггера `launchGraph` отдаёт граф как есть и `trigger: null`.

### 4.4. Процесс-узел: `swag/process@1.0.0` и `expandGraph`

Пакет `packages/node-process` (`@swag/node-process`), `src/node.ts` и `swag-node.json` по образцу `@swag/node-llm-agent`:

```ts
export default defineNode({
  type: 'swag/process',
  version: '1.0.0',
  kind: 'program',
  title: 'Процесс',
  description: 'Сохранённый процесс организации как шаг графа. Разворачивается платформой в узлы процесса, не исполняется в песочнице.',
  settings: z.strictObject({ processId: z.uuid() }),
  inputs: z.unknown(),
  outputs: z.unknown(),
  execute: async () => { throw new Error('swag/process is expanded by the platform'); },
});
```

```ts
// packages/api-integration/src/process-graph.ts
export const PROCESS_NODE_TYPE = 'swag/process@1.0.0';
export const PROCESS_NEST_MAX_DEPTH = 3; // корень + два уровня вложенности

export interface NodeOrigin { processId: string; nodeId: NodeId } // процесс и id узла в его графе

export type ExpandResult =
  | { ok: true; graph: ProcessGraph; origin: Record<NodeId, NodeOrigin | null> } // null — узел корневого графа
  | { ok: false; issues: GraphIssue[] };

// rootId — id процесса корневого графа (null у роя); children — графы процессов организации по id.
export function expandGraph(graph: ProcessGraph, children: ReadonlyMap<string, ProcessGraph>, rootId: string | null): ExpandResult;
```

Алгоритм для узла `p` с `type = PROCESS_NODE_TYPE` и `settings.processId = c`, узлы по порядку массива, рекурсивно с глубины 1:
1. `c` нет в `children` — `process_not_found`, путь `nodes.<i>.settings.processId`. `c` уже на пути от корня (включая `rootId`) — `process_cycle`, тот же путь. Глубина узла больше `PROCESS_NEST_MAX_DEPTH - 1` — `process_too_deep`, тот же путь.
2. Граф `c` сначала разворачивается сам. Замечания внутри него — одно `process_invalid` на узел `p` с сообщением `<code> at <path>` первого замечания.
3. Если в графе `c` есть триггер, он и его `flow` убираются (`launchGraph`); вход `c` — цель его `flow`, иначе `entry` графа `c`. Выход `c` — `exit` графа `c`.
4. Узлы `c` получают id `<p>-<id>` в порядке их графа и встают в массив узлов на место `p`. Id не проходит `NodeId` (длиннее 40) — `process_node_id_too_long`, путь `nodes.<i>.id`.
5. Рёбра `c` переименовываются так же и добавляются в конец массива рёбер. Входящие `flow` родителя в `p` ведут в `<p>-<вход c>`, исходящие идут из `<p>-<выход c>`. `entry` или `exit` родителя, равные `p`, — `<p>-<вход c>` и `<p>-<выход c>`.
6. `origin` узла из `c` — `{ processId: c, nodeId: id в графе c }`; при нескольких уровнях — самый внутренний процесс.

Бюджет, `maxTokens`, `maxConcurrent` и включённость дочернего процесса не используются: развёрнутые узлы исполняются в рое родителя, в его бюджете и `SWARM_TIMEOUT_MS`.

### 4.5. Триггер-расписание: `swag/schedule@1.0.0` и `CronSchedule`

Пакет `packages/node-schedule` (`@swag/node-schedule`), по образцу `@swag/node-llm-agent`:

```ts
export default defineNode({
  type: 'swag/schedule',
  version: '1.0.0',
  kind: 'trigger',
  title: 'Расписание',
  description: 'Запуск процесса по интервалу или по cron. Исполняется платформой, без песочницы.',
  settings: z.strictObject({
    everySec: z.number().int().min(60).max(604_800).nullable().default(null),
    cron: z.string().trim().min(1).max(100).nullable().default(null), // 5 полей: минута час день месяц день-недели
    timezone: z.string().min(1).max(64).default('UTC'), // IANA
  }),
  outputs: z.strictObject({ scheduledAt: z.iso.datetime(), firedAt: z.iso.datetime() }),
  poll: async () => { throw new Error('swag/schedule is run by the platform'); },
});
```

```ts
// packages/api-core/src/index.ts, порт
export interface CronSchedule {
  check(cron: string, timezone: string): 'ok' | 'invalid_cron' | 'invalid_timezone';
  next(cron: string, timezone: string, after: Date): Date | null; // первое срабатывание строго после after
}
export const SCHEDULE_TRIGGER_TYPE = 'swag/schedule@1.0.0';
```

Адаптер — `packages/adapter-croner`, `createCronerSchedule(): CronSchedule` на `croner@9.1.0` (Q-5), 5 полей без секунд.

Проверка при сохранении (после `checkGraph`), по замечанию `invalid_settings`:
- заданы оба `everySec` и `cron` или ни одного — путь `nodes.<i>.settings`, сообщение `set exactly one of everySec and cron`;
- `check` = `invalid_cron` — путь `nodes.<i>.settings.cron`; `invalid_timezone` — путь `nodes.<i>.settings.timezone`.

Время следующего срабатывания `nextScheduleRun(settings, after)`: `everySec` — `after + everySec`; `cron` — `next(cron, timezone, after)`, `null` — процесс выключается с `poll_failed` и `lastError { code: 'schedule_exhausted' }`.

### 4.6. Порты `api-core`

```ts
export interface ProcessRecord {
  id: string;
  orgId: string;
  createdBy: string;
  definition: ProcessDraft;
  enabled: boolean;
  disabledReason: ProcessDisabledReason | null;
  cursor: string | null;
  nextRunAt: string | null;
  lastPollAt: string | null;
  lastError: ProcessError | null;
  consecutiveFailures: number;
  createdAt: string;
  updatedAt: string;
}

export interface ActivationRecord {
  id: string;
  processId: string;
  orgId: string;
  status: ActivationStatus;
  reason: ActivationRejectReason | null;
  source: ActivationSource;
  event: unknown; // null вне queued и launching
  createdAt: string;
  launchedAt: string | null;
}

// Результат такта по процессу: пишется одной транзакцией, снимает аренду.
export interface TickRecord {
  cursor: string | null;
  nextRunAt: string | null;
  lastPollAt: string | null;
  lastError: ProcessError | null;
  consecutiveFailures: number;
  enabled: boolean;
  disabledReason: ProcessDisabledReason | null;
  enqueue: ActivationRecord[];
}

export interface ProcessStore {
  create(record: ProcessRecord): Promise<void>;
  update(record: ProcessRecord): Promise<void>; // целиком, по id
  get(id: string): Promise<ProcessRecord | null>;
  list(orgId: string | null): Promise<ProcessRecord[]>; // null — все организации
  count(orgId: string): Promise<number>;
  delete(id: string): Promise<boolean>; // активации удаляются каскадом
  claimDue(now: string, leaseUntil: string, limit: number): Promise<ProcessRecord[]>; // enabled, nextRunAt <= now, аренды нет или истекла; по nextRunAt
  recordTick(id: string, tick: TickRecord): Promise<void>;
  enqueue(activation: ActivationRecord): Promise<void>;
  queuedCount(processId: string): Promise<number>; // queued + launching
  takeQueued(limit: number): Promise<ActivationRecord[]>; // queued → launching атомарно, по createdAt
  finishActivation(id: string, status: 'queued' | 'launched' | 'rejected' | 'cancelled', reason: ActivationRejectReason | null, launchedAt: string | null): Promise<void>; // кроме queued — event = null
  cancelQueued(processId: string): Promise<number>;
  launching(): Promise<ActivationRecord[]>;
  activations(processId: string, limit: number): Promise<ActivationRecord[]>; // createdAt по убыванию
}

export interface RootSpans {
  run<T>(name: 'process.poll' | 'process.activation', attributes: { 'swag.process': string }, fn: () => Promise<T>): Promise<T>;
}

export interface OrchestratorClient {
  launch(launch: SwarmLaunch): Promise<void>;
  stop(swarmId: string): Promise<void>;
  invokeNode(invocation: NodeInvocation): Promise<NodeInvocationResult>; // POST /node-invocations; сеть и не-2xx — исключение
}
```

`ApiCoreDeps` получает `processes: ProcessStore`, `cron: CronSchedule`, `spans: RootSpans`, а `limits` — поля `processQueueMax`, `processPollMaxFailures`, `processMaxPerOrg`, `processLeaseMs`, `processPollTimeoutMs`.

Адаптеры: `createMemoryProcessStore()` в `packages/adapter-memory`; `createPostgresProcessStore(pool)` в `packages/adapter-postgres`; `createRootSpans(telemetry)` в `packages/adapter-telemetry` (корневой спан без родителя, контекст активен на время `fn`). HTTP-клиент оркестратора: `invokeNode` — `POST /node-invocations` с тем же токеном и `traceparent`, таймаут запроса — `invocation.timeoutMs + 10000`.

### 4.7. Хранение: `packages/adapter-postgres/migrations/0007_processes.sql`

```sql
-- Up Migration
create table processes (
  id uuid primary key,
  org_id uuid not null references organizations (id),
  created_by uuid not null references users (id),
  definition jsonb not null,
  enabled boolean not null,
  disabled_reason text null,
  cursor text null,
  next_run_at timestamptz null,
  lease_until timestamptz null,
  last_poll_at timestamptz null,
  last_error jsonb null,
  consecutive_failures integer not null,
  created_at timestamptz not null,
  updated_at timestamptz not null
);
create index processes_org_idx on processes (org_id, updated_at desc);
create index processes_due_idx on processes (next_run_at) where enabled;

create table process_activations (
  id uuid primary key,
  process_id uuid not null references processes (id) on delete cascade,
  org_id uuid not null,
  status text not null,
  reason text null,
  source text not null,
  event jsonb null,
  created_at timestamptz not null,
  launched_at timestamptz null
);
create index process_activations_queue_idx on process_activations (created_at) where status = 'queued';
create index process_activations_process_idx on process_activations (process_id, created_at desc);

-- Down Migration
drop table process_activations;
drop table processes;
```

- `claimDue` — `update processes set lease_until = $2 where id in (select id from processes where enabled and next_run_at <= $1 and (lease_until is null or lease_until < $1) order by next_run_at limit $3 for update skip locked) returning *`.
- `recordTick` — одна транзакция: `update processes` полями `TickRecord`, `lease_until = null`, `updated_at` не меняется; `insert` активаций `enqueue`.
- `takeQueued` — `update process_activations set status = 'launching' where id in (select id … where status = 'queued' order by created_at limit $1 for update skip locked) returning *`.

### 4.8. API `api`

| Метод и путь | Право | Тело | Ответ | Ошибки |
|---|---|---|---|---|
| `POST /processes` | `process.manage` | `ProcessDraft` | `201 ProcessView` | `400 validation_error`, `400 invalid_graph`, `403`, `409 too_many_processes` |
| `GET /processes` | `process.read` | — | `200 ProcessList` (видимые) | `403` |
| `GET /processes/:id` | `process.read` | — | `200 ProcessView` | `403`, `404` |
| `PUT /processes/:id` | `process.manage` | `ProcessDraft` | `200 ProcessView` | как `POST` + `404` |
| `DELETE /processes/:id` | `process.manage` | — | `204` | `403`, `404`, `409 process_in_use` |
| `POST /processes/:id/enable` | `process.manage` | — | `200 ProcessView` | `400 invalid_graph`, `403`, `404`, `409 process_no_trigger` |
| `POST /processes/:id/disable` | `process.manage` | — | `200 ProcessView` | `403`, `404` |
| `POST /processes/:id/activations` | `process.manage` | `ActivationRequest` | `202 ActivationView` | `400 validation_error`, `400 invalid_event`, `403`, `404`, `409 queue_full` |
| `GET /processes/:id/activations` | `process.read` | — | `200 ActivationList` | `403`, `404` |

`app.ts` `STATUS`: `invalid_event: 400`, `process_no_trigger: 409`, `process_in_use: 409`, `too_many_processes: 409`, `queue_full: 409`.

Правила операций `api-core` (видимость `visibleProcess` — функция `visible` 024 по `orgId` и `createdBy` процесса; `actor.orgId === null` у `POST` — `403 forbidden`):
- **`createProcess`** — разбор `ProcessDraft`, лимит `PROCESS_MAX_PER_ORG`, `checkProcessDraft` (REQ-033-2): бюджеты → `checkGraph(graph, { …, triggers: true })` → `invalid_settings` расписания (4.5) → `expandGraph` (дочерние графы — процессы организации, `rootId` = id нового процесса) → `checkGraph` развёрнутого графа с `triggers: true`, у замечаний путь с префиксом `expanded.`. Запись: `enabled: false`, `disabledReason: null`, курсор и время — `null`, счётчик 0.
- **`updateProcess`** — те же проверки. Если узел-триггер изменился (id, тип, настройки или `credentials`), курсор сбрасывается в `null`; у включённого процесса `nextRunAt` считается заново по правилу включения.
- **`deleteProcess`** — есть процесс организации с узлом `swag/process`, `settings.processId` которого равен id, — `409 process_in_use`.
- **`enableProcess`** — нет триггера — `409 process_no_trigger`; проверка `checkProcessDraft` — `400 invalid_graph`. `enabled: true`, `disabledReason: null`, `consecutiveFailures: 0`, `lastError: null`; `nextRunAt` — сейчас для стороннего триггера, `nextScheduleRun(settings, сейчас)` для `swag/schedule`. Уже включённый — без изменений, `200`.
- **`disableProcess`** — `enabled: false`, `disabledReason: 'user'`, `nextRunAt: null`, `cancelQueued`.
- **`activateProcess`** — `ActivationRequest`; если есть триггер, `registry.validate(type, { place: 'outputs' }, event)` не `ok` — `400 invalid_event` с замечаниями; `queuedCount ≥ PROCESS_QUEUE_MAX` — `409 queue_full`; `enqueue` `{ status: 'queued', source: 'manual' }`.
- **`disableProcessesOfUser(userId)`** — каждый включённый процесс автора: `enabled: false`, `disabledReason: 'author_blocked'`, `nextRunAt: null`, `cancelQueued`. Вызывается в `createBlockHandler` (`apps/api/src/streams.ts`) после `stopSwarmsOfUser`.

`ProcessView.queued` — `queuedCount`, `running` — число `SwarmView` с `processId` процесса в `starting` или `running`.

### 4.9. Запуск роя и активации: `startSwarm`

`createSwarm` (009, 4.9) делится на разбор запроса и общий `startSwarm`; поведение `POST /swarms` не меняется, кроме разворачивания `swag/process`.

```ts
interface StartSwarm {
  swarmId: string;
  orgId: string;
  createdBy: string;
  processId: string | null;
  task: string; // у активации — valueText(event), обрезанный до 4000 символов
  graph: ProcessGraph; // корневой граф: у роя — из запроса, у активации — определение процесса
  trigger: { event: unknown } | null; // только у активации
  budgetMicroUsd: number;
  maxTokens: number | null;
}
```

Шаги `startSwarm`:
1. `expandGraph(graph, процессы организации, processId)`; `checkGraph` с `triggers: processId !== null`; у роя ещё `entry_input_invalid` (009). Замечания — `invalid_graph`.
2. `launchGraph` — граф запуска и триггер. `LaunchTrigger` = `{ nodeId: триггер.nodeId, event }` при `trigger`, иначе `null`.
3. `launchNodes` (009) по графу запуска; `stateKey` каждой программы — по REQ-033-16 через `origin` из шага 1.
4. Лимит активных роёв, резерв, `swarm.created` (с `processId`), `launch` — как в 009.

`createSwarm` вызывает `startSwarm` с `swarmId = ids.uuid()`, автором `actor.userId`, `processId: null`, `trigger: null`. Активация — с `swarmId` = id активации, автором процесса, `processId`, бюджетом и `maxTokens` определения.

### 4.10. Такт планировщика: `tickProcesses`

```ts
// ApiCore
tickProcesses(): Promise<{ polled: number; enqueued: number; launched: number }>;
recoverActivations(): Promise<number>; // REQ-033-19, при старте после closeInterrupted
```

Оболочка `apps/api` вызывает `tickProcesses` цепочкой `setTimeout(PROCESS_TICK_MS)`: следующий вызов — после окончания предыдущего; исключение такта — лог `process_tick_failed` с `errorName`, цепочка продолжается. Остановка `api` дожидается текущего такта.

Шаги такта (`now = clock.now()`):
1. **Захват.** `claimDue(now, now + PROCESS_LEASE_MS, PROCESS_TICK_BATCH)`, `PROCESS_TICK_BATCH = 20` — константа `api-core`.
2. **Опрос** каждого захваченного процесса — в `spans.run('process.poll', …)`:
   - `queuedCount ≥ PROCESS_QUEUE_MAX` — `recordTick` с прежним курсором, `nextRunAt = now + pollIntervalSec` (у `swag/schedule` — прежний `nextRunAt`, он остаётся в прошлом и даст догоняющее срабатывание), без активаций;
   - `swag/schedule` — активация `{ scheduledAt: nextRunAt, firedAt: now }`, `nextRunAt = nextScheduleRun(settings, now)`;
   - сторонний триггер — `orchestrator.invokeNode({ orgId, type, call: { kind: 'poll', cursor }, settings, credentials, stateKey: 'process:<id>:<triggerNodeId>', timeoutMs: processPollTimeoutMs })`. `ok` — активация на каждое событие `output.events`, курсор `output.cursor`, `consecutiveFailures: 0`, `lastError: null`. Не `ok` — `lastError { code: error.code, message: error.message, at: now }`; исключение клиента — `lastError { code: 'orchestrator_unavailable', message: 'orchestrator is unavailable', at: now }`; курсор прежний, счётчик + 1; счётчик достиг `PROCESS_POLL_MAX_FAILURES` — `enabled: false`, `disabledReason: 'poll_failed'`, `nextRunAt: null`. `nextRunAt = now + pollIntervalSec`, `lastPollAt = now`;
   - всё — одним `recordTick`. Активации: `{ status: 'queued', source: 'trigger', event, createdAt: now }`.
3. **Запуск.** `takeQueued(PROCESS_TICK_BATCH)`; по каждой — в `spans.run('process.activation', …)`:
   - процесса нет — пропустить (каскад удалит запись);
   - у процесса `running + запущенные в этом такте ≥ maxConcurrent` — `finishActivation(id, 'queued', null, null)`;
   - `startSwarm`: успех — `launched` с `launchedAt = now`; `insufficient_balance` или `invalid_graph` — `rejected` с причиной; `too_many_active_swarms` — эта и оставшиеся взятые активации снова `queued`, запуск в такте заканчивается. Сбой оркестратора внутри `startSwarm` даёт рой `failed` (009) и активацию `launched`.

`recoverActivations`: по `launching()` — `store.view(id)` есть → `launched`, иначе `queued`.

### 4.11. Конфиг `api` (`packages/config`, `ApiConfig`)

| Переменная | Тип | По умолчанию |
|---|---|---|
| `PROCESS_TICK_MS` | int ≥ 1000 | 5000 |
| `PROCESS_LEASE_MS` | int ≥ 10000 | 120000 |
| `PROCESS_POLL_TIMEOUT_MS` | int 1000…300000 | 30000 |
| `PROCESS_QUEUE_MAX` | int ≥ 1 | 20 |
| `PROCESS_POLL_MAX_FAILURES` | int ≥ 1 | 10 |
| `PROCESS_MAX_PER_ORG` | int ≥ 1 | 50 |

`PROCESS_LEASE_MS` MUST быть больше `PROCESS_POLL_TIMEOUT_MS + 10000` — иначе ошибка конфига при старте. Переменные — в `.env.example` и в локальный `.env`. `NODE_PACKAGES` по умолчанию (`compose.yaml` у `api` и `orchestrator`, `.env.example`, `.env`) получает `@swag/node-schedule,@swag/node-process`; пакеты — в зависимости `apps/api`, как `@swag/node-example`. В `apps/node-host` они не нужны: их код не исполняется.

## 5. Критерии приёмки

- **AC-033-1** — *Given* `ProcessDraft` без необязательных полей *When* разбор *Then* `maxTokens: null`, `pollIntervalSec: 300`, `maxConcurrent: 1`; `pollIntervalSec: 59` и `maxConcurrent: 5` отклоняются. `ROLE_PERMISSIONS`: `user` и `admin` — `process.read` и `process.manage`, `supervisor` — только `process.read`.
- **AC-033-2** — *Given* граф `t (swag/schedule) → a (агент)`, `entry = t`, `exit = a` *When* `checkGraph` с `triggers: true` *Then* `ok`; *When* без опции *Then* `node_kind_unsupported` у `t`.
- **AC-033-3** — *Given* (отдельные графы) триггер не `entry`; триггер-вход с двумя исходящими `flow`; триггер-вход без `flow`; `exit = t` *When* `checkGraph` с `triggers: true` *Then* среди замечаний — `trigger_not_entry`; `trigger_flow`; `trigger_flow`; `exit_not_step`.
- **AC-033-4** — *Given* граф AC-033-2 *When* `launchGraph` *Then* граф из одного `a`, `entry = exit = a`, без рёбер; `trigger.nodeId = 't'` с настройками после умолчаний; граф без триггера возвращается как есть с `trigger: null`.
- **AC-033-5** — *Given* родитель `e (echo) → p (swag/process → C)`, `C` — `t → x (echo) → y (echo)`, `entry = e`, `exit = p` *When* `expandGraph` *Then* узлы `e`, `p-x`, `p-y` (триггер `C` убран), рёбра `p-x → p-y`, `e → p-x`, `exit = p-y`; `origin['p-x'] = { processId: C, nodeId: 'x' }`, `origin.e = null`.
- **AC-033-6** — *Given* `swag/process` на отсутствующий процесс; на сам корень (`rootId`); цепочка глубины 4; дочерний узел с id в 38 символов при `p` в 5 символов; дочерний процесс, который сам ссылается на отсутствующий *When* `expandGraph` *Then* `process_not_found`; `process_cycle`; `process_too_deep`; `process_node_id_too_long`; `process_invalid` с сообщением `process_not_found at nodes.<i>.settings.processId` — пути по 4.4.
- **AC-033-7** — *Given* `SwarmLaunch` без `trigger` и `stateKey` *When* разбор *Then* `trigger: null`; программа вызывается со `stateKey = swarm:<id>:<nodeId>` (REQ-033-24). *Given* программа со `stateKey: 'process:c:x'` *Then* вызов `invokeNode` с ним.
- **AC-033-8** — *Given* `SwarmLaunch` с `trigger { nodeId: 't', event: { n: 1 } }`, шаг-вход — программа `p` *When* все агенты стартовали *Then* `execute` с входом `{ n: 1 }`. *Given* шаг-вход — команда `a` *Then* сообщение шины `from: 't'`, `to: 'a'`, `text: '{"n":1}'`, а env `a` — `AGENT_TASK_FROM=t`.
- **AC-033-9** — *Given* события `swarm.created` с `processId` и без поля *When* проекция *Then* `SwarmView.processId` — id и `null`.
- **AC-033-10** — *Given* фейк `ProcessStore` пуст, актор `user` *When* `POST /processes` с графом AC-033-2 и `everySec: 60` *Then* `201`, `enabled: false`, `trigger { nodeId: 't', type: 'swag/schedule@1.0.0' }`, `nextRunAt: null`; при `PROCESS_MAX_PER_ORG` процессах в организации — `409 too_many_processes`.
- **AC-033-11** — *Given* расписание с `everySec` и `cron` вместе; без обоих; `cron: 'bad'`; `timezone: 'Mars/Base'`; бюджет агента больше бюджета активации *When* `POST /processes` *Then* `400 invalid_graph` с `invalid_settings` по путям 4.5; бюджет — `400 validation_error`.
- **AC-033-12** — *Given* процесс без триггера *When* `enable` *Then* `409 process_no_trigger`. *Given* процесс со сторонним триггером и удалённым после сохранения секретом *When* `enable` *Then* `400 invalid_graph` с `secret_not_found`.
- **AC-033-13** — *Given* включённый процесс с двумя активациями в очереди *When* `disable` *Then* `disabledReason: 'user'`, `nextRunAt: null`, активации `cancelled`, их `event = null`.
- **AC-033-14** — *Given* процесс `B` с узлом `swag/process` на `A` *When* `DELETE /processes/A` *Then* `409 process_in_use`; после удаления `B` — `204`.
- **AC-033-15** — *Given* `PUT` включённого процесса с курсором `c1`: (1) меняется только бюджет, (2) меняются настройки триггера *When* сохранение *Then* (1) курсор `c1`, (2) курсор `null` и `nextRunAt` = сейчас.
- **AC-033-16** — *Given* пользователи `u1`, `u2` одной организации, `admin`, `supervisor`, пользователь другой организации *When* `GET /processes`, `GET /processes/:id`, `PUT`, `POST …/activations` по процессу `u1` *Then* `u1` и `admin` видят и меняют; `u2` и чужая организация — `404`; `supervisor` видит, `PUT` — `403`.
- **AC-033-17** — *Given* процесс с триггером-фикстурой *When* `POST /processes/:id/activations` с событием не по `outputs` *Then* `400 invalid_event`; с событием по `outputs` *Then* `202`, `status: 'queued'`, `source: 'manual'`, в том числе у выключенного процесса; при `PROCESS_QUEUE_MAX` в очереди — `409 queue_full`.
- **AC-033-18** — *Given* включённый процесс с триггером-фикстурой, фейк `invokeNode` отдаёт `{ events: [e1, e2], cursor: 'c2' }` *When* `tickProcesses` *Then* вызов `poll` с курсором процесса, `stateKey = process:<id>:<t>`, `timeoutMs = PROCESS_POLL_TIMEOUT_MS`; две активации в порядке `e1`, `e2`; курсор `c2`; `nextRunAt = now + pollIntervalSec`; аренда снята.
- **AC-033-19** — *Given* фейк `invokeNode` отдаёт `{ ok: false, code: 'timeout' }`, затем бросает исключение *When* два такта *Then* курсор прежний, активаций нет, `lastError.code` — `timeout`, затем `orchestrator_unavailable`, `consecutiveFailures: 2`; *When* счётчик дошёл до `PROCESS_POLL_MAX_FAILURES` *Then* `enabled: false`, `disabledReason: 'poll_failed'`, очередь не тронута.
- **AC-033-20** — *Given* в очереди процесса `PROCESS_QUEUE_MAX` активаций *When* такт *Then* `poll` не вызывается, курсор прежний.
- **AC-033-21** — *Given* `swag/schedule` с `everySec: 60`, `nextRunAt = 10:00:00`, фейковые часы `10:00:03` *When* такт *Then* одна активация с событием `{ scheduledAt: '…10:00:00…', firedAt: '…10:00:03…' }`, `nextRunAt = 10:01:03`, оркестратор не вызывается. *Given* `nextRunAt` на час в прошлом *Then* одна активация.
- **AC-033-22** — *Given* `swag/schedule` с `cron: '0 9 * * *'`, `timezone: 'Europe/Moscow'` *When* `enable` в `2026-11-03T10:00:00Z` *Then* `nextRunAt = 2026-11-04T06:00:00.000Z` (адаптер croner, тест в `adapter-croner`).
- **AC-033-23** — *Given* процесс `t → x (echo) → a` с `maxConcurrent: 1`, три активации в очереди, баланс достаточный *When* такт *Then* запущена одна: рой с id активации, `swarm.created.data.processId`, `createdBy` — автор процесса, резерв на `budgetMicroUsd` определения, `SwarmLaunch.trigger.nodeId = 't'`, программа `x` со `stateKey process:<id>:x`; две остались `queued`. *When* рой завершён и следующий такт *Then* запущена вторая.
- **AC-033-24** — *Given* баланса не хватает; в графе процесса удалён секрет; достигнут `MAX_ACTIVE_SWARMS` *When* такт *Then* `rejected` `insufficient_balance`; `rejected` `invalid_graph`; активация осталась `queued`. Процесс включён во всех трёх случаях; `event = null` у `rejected`.
- **AC-033-25** — *Given* два ядра `api` на одном `ProcessStore` (адаптер Postgres, стек-тест) и одна активация в очереди *When* такты обоих одновременно *Then* рой запущен один раз; процесс, захваченный одним тактом, второй не опрашивает.
- **AC-033-26** — *Given* активация в `launching` с роем и без роя *When* `recoverActivations` *Then* `launched` и `queued`.
- **AC-033-27** — *Given* у автора два включённых процесса с очередью *When* обработчик блокировки *Then* оба `enabled: false`, `disabledReason: 'author_blocked'`, очередь `cancelled`; процессы другого пользователя не тронуты.
- **AC-033-28** — *Given* `POST /swarms` с графом `e (echo) → p (swag/process → C)` *When* запуск *Then* `SwarmLaunch.programs` — `e` со `stateKey swarm:<id>:e`, `p-x` и `p-y` со `stateKey process:<C>:x` и `process:<C>:y`; `trigger: null`. Процесс `C` из другой организации — `400 invalid_graph` с `process_not_found`.
- **AC-033-29** — *Given* событие триггера с маркером `event-marker-033`, курсор `cursor-marker-033`, настройки `settings-marker-033` *When* опрос и запуск активации на фейках *Then* маркеров нет в логах `api-core`; после `launched` маркера события нет в `ActivationRecord`; `ActivationView` и `ProcessView` не содержат события и курсора.
- **AC-033-30** — *Given* фейк `RootSpans` *When* такт с опросом и запуском *Then* `run('process.poll', { 'swag.process': id })` вокруг `invokeNode`, `run('process.activation', …)` вокруг `startSwarm`; `traceId` события `swarm.created` — из спана активации.
- **AC-033-31** — *Given* адаптер Postgres на тестовой БД *When* `create`, `update`, `claimDue` (аренда, `skip locked`), `recordTick` (курсор и активации одной транзакцией), `takeQueued`, `finishActivation` (очистка `event`), каскадное удаление *Then* поведение как у адаптера в памяти: общий набор тестов на оба адаптера.
- **AC-033-32** — *Given* `PROCESS_LEASE_MS = 30000`, `PROCESS_POLL_TIMEOUT_MS = 30000` *When* разбор `ApiConfig` *Then* ошибка конфига; умолчания по 4.11.
- **AC-033-35** — *Given* оболочка `apps/api` на фейковых таймерах, `tickProcesses` первого вызова висит, второго бросает *When* проходит `3 × PROCESS_TICK_MS` *Then* второй вызов начинается только после окончания первого; исключение — лог `process_tick_failed` с `errorName`, после него назначен следующий такт.
- **AC-033-33** `[manual]` — *Given* стек `npm run up`, вход пользователем кабинета, баланс пополнен *When* `POST /processes` с графом `t (swag/schedule, everySec: 60) → echo (prefix «> ») → agent-1`, `entry = t`, `exit = agent-1`, затем `enable` *Then* за 3 минуты — 2–3 роя с `processId` процесса, каждый `completed`, первое сообщение агенту — от `echo`, текст начинается с «> »; в Grafana трейс роя начинается спаном `process.activation`. *When* `disable` *Then* новых роёв нет 2 минуты. Проверка: curl с токеном, страница роя и Grafana; результат в журнал.
- **AC-033-34** `[manual]` — *Given* тот же стек *When* `POST /processes/:id/activations` у выключенного процесса без триггера (`echo → agent-1`) с событием `{ "text": "назови одно море" }` *Then* через ≤ `PROCESS_TICK_MS` + 2 с рой запущен, `GET /processes/:id/activations` — `launched` с `id` роя. Проверка: curl; результат в журнал.

## 6. Нефункциональные требования

| ID | Требование | Как измеряется |
|---|---|---|
| NFR-033-1 | Срабатывание расписания ставит активацию не позже `nextRunAt + PROCESS_TICK_MS + 1 с` при ≤ 20 включённых процессах | тест ядра на фейковых часах и такте; на стеке — по `createdAt` активаций в AC-033-33, результат в журнал |
| NFR-033-2 | `expandGraph` + `checkGraph` графа с тремя уровнями вложенности и 16 узлами после разворачивания — p95 < 10 мс | тест-замер на 1000 прогонах в `api-integration`, результат в журнал |

## 7. Безопасность: что не должно сломаться

- Процесс одной организации не видит и не запускает процессы и секреты другой: дочерний процесс ищется в организации родителя, `credentials` триггера — по секретам организации процесса, `orgId` опроса — организация процесса → AC-033-16, AC-033-28, AC-033-12.
- Активация не обходит деньги: резерв бюджета активации с баланса организации, отказ при нехватке, бюджет агента ≤ бюджета активации → AC-033-23, AC-033-24, AC-033-11.
- Процесс не захватывает ресурсы бесконтрольно: очередь ≤ `PROCESS_QUEUE_MAX`, `maxConcurrent`, `MAX_ACTIVE_SWARMS`, выключение после ошибок опроса, лимит процессов на организацию → AC-033-17, AC-033-19, AC-033-20, AC-033-23, AC-033-10.
- Заблокированный пользователь не продолжает тратить деньги организации через процессы → AC-033-27.
- Событие триггера (данные внешней системы, возможно персональные) живёт только в очереди и не попадает в логи и ответы API → AC-033-29.
- Активация не запускается дважды: аренда процесса, `launching` активации, восстановление после перезапуска → AC-033-25, AC-033-26.
- Рой пользователя ведёт себя как до 033 → AC-033-7, тесты 009.

## 8. Задачи для агента

Выполняются по порядку. После каждой задачи — коммит. Каждая задача — свой этап `spec/033-tN` в `main`: необязательные поля `SwarmLaunch` (4.2) не ломают `api` и оркестратор между этапами.

- [ ] **T-1.** Контракты: `packages/contracts/src/process.ts` по 4.1 и экспорт в `index.ts`; права `process.read`, `process.manage` и `ROLE_PERMISSIONS` в `access.ts`; новые коды `GraphIssueCode` в `graph.ts` (4.3); `LaunchProgram.stateKey`, `LaunchTrigger`, `SwarmLaunch.trigger` в `swarm.ts` (4.2); `processId` в `swarm.created` (`events.ts`). Тесты схем в `packages/contracts/test`. Закрывает: AC-033-1, REQ-033-20 (права). Готово, когда: тесты и `npm run typecheck` зелёные, прежние тесты пакета без правки ожиданий.
- [ ] **T-2.** Пакет `packages/node-schedule` по 4.5 (`package.json` и `tsconfig.json` по образцу `@swag/node-llm-agent`, `src/node.ts`, `swag-node.json` через `npm run nodes:manifest`, README, тест загрузки манифеста `loadNodePackages`). Закрывает: REQ-033-8 (тип узла). Готово, когда: тест зелёный, `swag-node.json` проходит `NodeManifest`.
- [ ] **T-3.** Пакет `packages/node-process` по 4.4 — так же, как T-2. Подключение обоих пакетов: зависимости `apps/api`, `NODE_PACKAGES` в `compose.yaml` (`api`, `orchestrator`), `.env.example`, `.env`. Закрывает: REQ-033-15 (тип узла). Готово, когда: тест загрузки зелёный, `npm run up` поднимает `api` и `orchestrator` с пятью типами в `GET /node-types`.
- [ ] **T-4.** `checkGraph` с опцией `triggers` и `launchGraph` в `packages/api-integration/src/process-graph.ts` (4.3); тестовый триггер-фикстура в файле теста. Закрывает: REQ-033-3, AC-033-2, AC-033-3, AC-033-4. Готово, когда: тесты AC и прежние тесты 009 зелёные без правки ожиданий.
- [ ] **T-5.** `expandGraph`, `PROCESS_NODE_TYPE`, `PROCESS_NEST_MAX_DEPTH`, `NodeOrigin` в том же файле (4.4), экспорт. Закрывает: REQ-033-15, AC-033-5, AC-033-6, NFR-033-2. Готово, когда: тесты AC зелёные, замер NFR в журнале.
- [ ] **T-6.** `SwarmView.processId` в `packages/api-integration/src/swarm-view.ts` (4.2). Закрывает: AC-033-9. Готово, когда: тест AC и прежние тесты проекции зелёные.
- [ ] **T-7.** `orchestrator-core`: `stateKey` из `LaunchProgram` с умолчанием `swarm:<swarmId>:<nodeId>`; вход шага-входа от `launch.trigger` (значение, отправитель, `AGENT_TASK_FROM`) в `checkReady` и `agentSpec` (4.2, REQ-033-13). Закрывает: REQ-033-13, REQ-033-24, AC-033-7, AC-033-8. Готово, когда: тесты AC и прежние тесты оркестратора зелёные.
- [ ] **T-8.** Порт `CronSchedule` в `api-core` (только интерфейс и `SCHEDULE_TRIGGER_TYPE`) и пакет `packages/adapter-croner` с `createCronerSchedule` на `croner@9.1.0`, README. Закрывает: AC-033-22. Готово, когда: тест AC-033-22, тесты `check` (`invalid_cron`, `invalid_timezone`) и `npm run arch:check` зелёные.
- [ ] **T-9.** Порты `ProcessStore`, `ProcessRecord`, `ActivationRecord`, `TickRecord`, `RootSpans`, `OrchestratorClient.invokeNode` в `packages/api-core/src/index.ts` (4.6, без операций); `createMemoryProcessStore` в `packages/adapter-memory` с общим набором тестов хранилища в `packages/adapter-memory/test/process-store.cases.ts`. Закрывает: AC-033-31 (память). Готово, когда: набор зелёный на адаптере в памяти, `api-core` компилируется.
- [ ] **T-10.** Миграция `0007_processes.sql` и `createPostgresProcessStore` в `packages/adapter-postgres` (4.7); тот же набор тестов на тестовой БД (стек-тест). Закрывает: AC-033-31, AC-033-25 (хранилище). Готово, когда: набор зелёный на Postgres, `skip locked` проверен двумя соединениями.
- [ ] **T-11.** `invokeNode` в `packages/adapter-orchestrator-http` (4.6) и `createRootSpans` в `packages/adapter-telemetry`. Закрывает: REQ-033-6 (транспорт), REQ-033-22 (адаптер). Готово, когда: тесты адаптеров (путь, токен, `traceparent`, таймаут, исключение на не-2xx; спан без родителя) зелёные.
- [ ] **T-12.** `api-core`: `startSwarm` по 4.9 — `createSwarm` через него, `expandGraph` в `POST /swarms`, `stateKey` программ, `trigger: null`, `processId: null`. Закрывает: REQ-033-16, REQ-033-24, AC-033-28. Готово, когда: тест AC и прежние тесты `api-core` и `apps/api` зелёные без правки ожиданий (кроме `stateKey` в ожидаемом `SwarmLaunch`).
- [ ] **T-13.** `api-core`: `createProcess`, `getProcess`, `listProcesses`, `updateProcess`, `deleteProcess` с `checkProcessDraft` и видимостью (4.8). Закрывает: REQ-033-1, REQ-033-2, REQ-033-17, REQ-033-20, REQ-033-23, AC-033-10, AC-033-11, AC-033-14, AC-033-15, AC-033-16. Готово, когда: тесты AC зелёные.
- [ ] **T-14.** `api-core`: `enableProcess`, `disableProcess`, `activateProcess`, `listActivations`, `disableProcessesOfUser` (4.8). Закрывает: REQ-033-4, REQ-033-14, REQ-033-18, AC-033-12, AC-033-13, AC-033-17, AC-033-27. Готово, когда: тесты AC зелёные.
- [ ] **T-15.** `api-core`: `tickProcesses`, шаги 1–2 (захват, опрос, расписание) по 4.10. Закрывает: REQ-033-5, REQ-033-6, REQ-033-7, REQ-033-8, REQ-033-9, AC-033-18…AC-033-21, NFR-033-1 (ядро). Готово, когда: тесты AC зелёные.
- [ ] **T-16.** `api-core`: шаг 3 такта (запуск из очереди) и `recoverActivations` по 4.10; очистка события и маркеры. Закрывает: REQ-033-10, REQ-033-11, REQ-033-12, REQ-033-19, REQ-033-21, REQ-033-22, AC-033-23, AC-033-24, AC-033-26, AC-033-29, AC-033-30. Готово, когда: тесты AC зелёные.
- [ ] **T-17.** Конфиг: переменные 4.11 в `ApiConfig` (`packages/config`) с проверкой аренды, `.env.example`, `.env`. Закрывает: AC-033-32. Готово, когда: тест конфига зелёный.
- [ ] **T-18.** Оболочка `apps/api`: маршруты 4.8 и коды `STATUS`, сборка `createPostgresProcessStore`, `createCronerSchedule`, `createRootSpans`, лимитов; цепочка такта и `recoverActivations` при старте (4.10); `disableProcessesOfUser` в `createBlockHandler`; HTTP-тесты маршрутов; стек-тест AC-033-25. Закрывает: AC-033-25, AC-033-35, REQ-033-5 (оболочка), REQ-033-18 (оболочка). Готово, когда: тесты `apps/api` и `npm run check` зелёные.
- [ ] **T-19.** Глоссарий (сверка), README пакетов `contracts`, `api-integration`, `api-core`, `orchestrator-core`, `adapter-memory`, `adapter-postgres`, `adapter-orchestrator-http`, `adapter-telemetry`, `adapter-croner`, `node-schedule`, `node-process`, `config`, `apps/api`; корневой README (маршруты `/processes`, переменные); раздел «Процессы и триггеры» в `docs/architecture.md`; ручные AC-033-33, AC-033-34 и замер NFR-033-1 на стеке в журнал. Закрывает: AC-033-33, AC-033-34, NFR-033-1. Готово, когда: README сверены с кодом, проверки в журнале.

## 9. Открытые вопросы

Пока список не пуст, спека не может быть `ready`.

- [ ] **Q-1. Где живёт планировщик.** Варианты: **(а)** в `api`: операции `tickProcesses` в `api-core`, таймер в оболочке `apps/api`, аренда в Postgres защищает от двойного опроса при нескольких репликах; **(б)** отдельный сервис `apps/scheduler` с ядром `scheduler-core`, которое ходит в `api` по HTTP. Рекомендация — **(а)**: запуск активации — это `startSwarm` с резервом, графом и событиями, и всё это уже в `api-core`; отдельный сервис дублировал бы API или требовал внутренних маршрутов, а масштаб пока одна реплика. Вынести можно позже, ядро от оболочки не зависит. *(Claude, 2026-11-03)*
- [ ] **Q-2. Активация = рой.** В черновике активация в очереди — запись `process_activations`, а запущенная — рой с тем же id: события, проекция, страница роя, резерв и трейс 009 без изменений, `processId` в `swarm.created`. Альтернатива — своя сущность активации со своими событиями и проекцией. Рекомендация — рой: роадмап описывает активацию ровно как жизненный цикл роя, а кабинет и деньги уже работают с роями. *(Claude, 2026-11-03)*
- [ ] **Q-3. Права и видимость процессов.** В черновике новые права `process.read` (`user`, `admin`, `supervisor`) и `process.manage` (`user`, `admin`), видимость как у роёв: `user` — свои, `admin` — организации. Роадмап говорит, что бот принадлежит организации, а не пользователю. Варианты: **(а)** как у роёв; **(б)** все пользователи организации видят все её процессы, меняют — автор и `admin`; **(в)** процессы создаёт и меняет только `admin`. Рекомендация — **(а)** сейчас: одно правило видимости для роёв и их активаций; правила бота — в 018. *(Claude, 2026-11-03)*
- [ ] **Q-4. Чьи права у активации.** Активация запускается от имени автора процесса (`createdBy` роя — автор), блокировка автора выключает его процессы (REQ-033-18). Альтернатива — процесс принадлежит организации, активации идут от служебного актора и переживают блокировку автора. Рекомендация — от автора: видимость роёв активации у автора и `admin` работает без новых правил, а заблокированный не тратит деньги организации. *(Claude, 2026-11-03)*
- [ ] **Q-5. Библиотека cron.** Расписание по cron требует разбора выражения и часовых поясов. Варианты: **(а)** `croner@9.1.0` (MIT, без зависимостей, часовые пояса через `Intl`); **(б)** `cron-parser` (зависит от `luxon`); **(в)** только интервал `everySec`, cron — позже. Библиотека подключается адаптером `adapter-croner` за портом `CronSchedule`, белый список зависимостей ядер не меняется. Рекомендация — **(а)**. Подтвердить и формат: 5 полей без секунд, часовой пояс по умолчанию `UTC`. *(Claude, 2026-11-03)*
- [ ] **Q-6. Вложенный процесс разворачивается в граф родителя.** В черновике `swag/process` разворачивается в `api` до проверки: один рой, общий бюджет и `SWARM_TIMEOUT_MS`, бюджет и `maxConcurrent` дочернего процесса не используются, состояние узлов — общее с собственными активациями дочернего процесса (`process:<childId>:<nodeId>`), id узлов — `<p>-<id>` (≤ 40 символов). Альтернатива — дочерний процесс запускается отдельным роем-активацией, родитель ждёт его результата, бюджет дочернего выделяется из резерва родителя (D-77: «деление бюджета и таймаута»). Рекомендация — разворачивание: оркестратор не меняется, деления бюджета и таймаута нет — они общие; дочерний рой с ожиданием — когда понадобится вложенность команд с памятью (018). Подтвердить и глубину 3. *(Claude, 2026-11-03)*
- [ ] **Q-7. Нехватка баланса при запуске.** В черновике активация получает `rejected` `insufficient_balance` и не повторяется, процесс остаётся включённым. Варианты: **(а)** так; **(б)** активация остаётся в очереди до пополнения (очередь блокируется); **(в)** процесс выключается. Рекомендация — **(а)**: событие не теряется молча (видно в списке активаций), очередь не стоит, а пополнение не требует ручного включения. *(Claude, 2026-11-03)*
- [ ] **Q-8. Числа.** Подтвердить или назвать свои: опрос по умолчанию 300 с, не чаще 60 с; расписание не чаще 60 с; такт 5 с; очередь 20 на процесс; `maxConcurrent` 1, не больше 4; выключение после 10 ошибок опроса подряд; 50 процессов на организацию; аренда 120 с; таймаут опроса 30 с. Рекомендация — так; лимиты из env, кроме `PROCESS_POLL_MIN_SEC`, `PROCESS_MAX_CONCURRENT`, `PROCESS_NEST_MAX_DEPTH`, `PROCESS_TICK_BATCH` — константы. *(Claude, 2026-11-03)*
- [ ] **Q-9. Ручная активация.** В черновике есть `POST /processes/:id/activations` — запуск процесса своим событием, в том числе выключенного и без триггера. Нужен для проверки процесса без ожидания триггера и для редактора 017. Альтернатива — без ручного запуска в 033. Рекомендация — оставить: одна операция поверх той же очереди. *(Claude, 2026-11-03)*

## 10. Журнал реализации

Заполняет агент.

| Дата | Ветка / коммит | Что сделано | Отклонения от спеки |
|---|---|---|---|
