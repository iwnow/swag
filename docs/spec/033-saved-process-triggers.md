---
id: "033"
title: Сохранённый процесс и запуск по триггеру
status: in-progress
roadmap_stage: 9
depends_on: ["009", "021", "026", "013", "024"]
superseded_by: null
updated: 2026-11-03
---

# 033. Сохранённый процесс и запуск по триггеру

> **Коротко.**
> - Появляется **процесс** `Process` — сохранённое определение организации: имя, граф `ProcessGraph`, бюджет и `maxTokens` одного запуска, интервал опроса, предел одновременных запусков. Определение хранит `api` (`/processes`, права `process.read` и `process.manage`, видимость как у исполнений `swarms` 024).
> - **Запуск процесса** `ProcessRun` — своя сущность (Q-2). Термины (Q-10): процесс состоит из узлов; узлом может быть другой процесс; агенты — умные узлы с агентным циклом, связанные `link`. «Рой» — синоним процесса в исполнении, `Swarm` в коде не переименовывается. Запуск ставится в очередь по событию триггера или вручную, затем исполняется оркестратором; статус запуска хранится в планировщике.
> - **Планировщик** — отдельный сервис `apps/scheduler` с ядром `scheduler-core` (Q-1). Хранит в Postgres задания (триггер, курсор, время следующего опроса, включённость) и запуски со статусами; опрашивает триггеры, ведёт очередь и сам запускает процессы через внутренний маршрут `api`. Задание захватывается арендой, поэтому несколько реплик не опрашивают его дважды.
> - В графе процесса разрешён один узел-**триггер**, он же `entry`, с одним `flow`. Сторонний триггер опрашивается `poll(cursor)` через оркестратор (026); курсор сдвигается в одной транзакции с постановкой событий в очередь. Встроенный **`swag/schedule@1.0.0`** — интервал или cron, исполняется планировщиком без песочницы.
> - **Процесс как узел** — `swag/process@1.0.0` с `processId`. `api` разворачивает его в узлы дочернего процесса прямо в граф родителя: одно исполнение, общий бюджет и таймаут, глубина ≤ 3.
> - После 10 ошибок опроса подряд задание выключается само; блокировка автора выключает его процессы; каждый опрос и запуск — свой корневой трейс.
> - **Что нужно от человека:** Q-1…Q-10 закрыты; перевести спеку в `ready`.

## 1. Контекст и цель

Роадмап, [«Рой как узел графа»](../../AI_PLATFORM_ROADMAP.md#рой) и [раздел 4 «Граф процесса»](../../AI_PLATFORM_ROADMAP.md#4-граф-процесса), этап 9: определение хранится отдельно от запусков, процесс запускается событием триггера, команда агентов спит, пока работы нет, и сама может быть узлом процесса. Спека 009 (Q-1, ответ «а») вынесла сюда триггеры, сохранённый процесс и вложенность; Q-3 и Q-10 009 — очередь на сохранённый процесс и `stateKey` `process:<processId>:<nodeId>`.

Сейчас граф живёт только внутри запроса `POST /swarms`: `api` проверяет и сразу исполняет его, узлы `trigger` отклоняются (`node_kind_unsupported`). `poll` триггера оркестратор исполнять умеет (`POST /node-invocations`, 026), но его никто не вызывает, курсор хранить негде, планировщика нет.

После спеки организация сохраняет процесс с триггером и включает его. Планировщик сам опрашивает триггеры и расписания, ставит запуски в очередь и запускает их. У каждого запуска свой статус, события исполнения, стоимость и трейс. Сохранённый процесс можно вставить узлом в граф другого процесса. Бот 018 строится на этом: триггер канала — тот же опрос, диалог — слой поверх запусков.

**Термины (Q-2, Q-10).** Процесс — граф из узлов процесса. Узлом процесса может быть другой процесс (4.4). Агент — умный узел процесса с агентным циклом; агенты, связанные рёбрами `link`, работают командой, это шаг-команда процесса (009, 4.1). **Рой** — синоним процесса в исполнении: исполнение графа в коде, API, событиях и UI называется `Swarm` (`POST /swarms`, `swarm.*`, `SwarmView`, `swarmId`, страница «Рой») и не переименовывается. В этой спеке это **исполнение** запуска, его id совпадает с id запуска.

## 2. Объём

**Входит:**
- контракты процесса, задания и запуска (`packages/contracts/src/process.ts`), права `process.read`, `process.manage`;
- граф процесса: узел-триггер в `checkGraph` (опция `triggers`), `launchGraph` — граф исполнения без триггера;
- процесс-узел `swag/process@1.0.0` и разворачивание `expandGraph`, в том числе в графе `POST /swarms`;
- встроенный триггер `swag/schedule@1.0.0` (пакет `@swag/node-schedule`), порт `CronSchedule` и адаптер на croner;
- `SwarmLaunch.trigger` и `LaunchProgram.stateKey`; вход шага-входа от триггера в `orchestrator-core`;
- `processId` в `swarm.created` и `SwarmView`;
- сервис `apps/scheduler` и ядро `packages/scheduler-core`: задания, очередь и статусы запусков в Postgres, такт, опрос, расписание, запуск, сверка статусов, восстановление после перезапуска;
- определения процессов в `api`: CRUD, включение, выключение, ручной запуск, список запусков — поверх внутреннего API планировщика;
- внутренние маршруты `api` для планировщика: запуск исполнения и статусы исполнений;
- HTTP-клиенты между `api`, планировщиком и оркестратором; миграция `0007_processes.sql`;
- выключение процессов заблокированного автора; корневой трейс на опрос и на запуск.

**Не входит** (агент это не делает, даже если кажется логичным):
- переименование `Swarm` в коде, API, событиях и UI — не делается: рой — синоним процесса в исполнении (Q-10);
- UI процессов: список, форма, включение, история запусков в кабинете — 017 (редактор графа); исполнение запуска видно в кабинете на странице роя;
- проверка графа процесса без сохранения (`POST /graph-checks` с триггером) — 017, вместе с D-182;
- триггер с подпиской `start`/`stop`, вебхуки — 020;
- узел-канал, диалог, процесс на диалог, память между запусками, аренда диалога — 018;
- опрос нескольких триггеров одной песочницей, лимит одновременных вызовов узлов — 005 (N-33);
- повтор упавших запусков, дедупликация событий триггера, повторная попытка при нехватке баланса;
- лимит трат процесса за сутки или месяц, баланс ИИ — 025;
- версии определения процесса и история правок;
- построение процесса координатором — 027;
- слияние потоков, ветвления, маппинг полей — 017/027 (009, Q-6);
- модель трейса долгого диалога — 018 (D-13).

## 3. Требования

| ID | Требование | Приоритет |
|---|---|---|
| REQ-033-1 | `api` MUST хранить определение процесса (`ProcessDraft`, 4.1), автора и организацию; CRUD — по 4.11. Задание процесса (триггер, курсор, включённость, время опроса, ошибки) и запуски MUST храниться в планировщике (4.8). | MUST |
| REQ-033-2 | Сохранение процесса (`POST`, `PUT`) MUST проверять определение: разбор `ProcessDraft`; бюджетные проверки как у исполнения (`SWARM_MAX_BUDGET_MICRO_USD`, бюджет агента ≤ бюджета запуска, `AGENT_MAX_TOKENS_LIMIT`); `checkGraph` с `triggers: true`; настройки `swag/schedule` (4.5); `expandGraph` и проверку развёрнутого графа. Замечания графа — `400 invalid_graph` в формате 009, 4.9. | MUST |
| REQ-033-3 | `checkGraph` с `triggers: true` MUST разрешать узлы вида `trigger` по правилам 4.3; без опции MUST вести себя как в 009. | MUST |
| REQ-033-4 | При каждом сохранении `api` MUST передавать планировщику задание процесса (`PUT /jobs/:processId`) до записи определения. Изменился узел-триггер (id, тип, настройки, `credentials`) — планировщик MUST сбросить курсор, у включённого задания пересчитать `nextRunAt`. | MUST |
| REQ-033-5 | Включить MUST можно только процесс с триггером (`409 process_no_trigger`); перед включением граф MUST проверяться заново. Выключение пользователем MUST отменять запуски в очереди (`cancelled`); идущие исполнения MUST продолжаться. | MUST |
| REQ-033-6 | Такт планировщика MUST каждые `PROCESS_TICK_MS` захватывать включённые задания, у которых подошло время, арендой на `PROCESS_LEASE_MS`: захваченное задание MUST NOT опрашиваться другим тактом, пока аренда не снята или не истекла. Следующий такт MUST начинаться после окончания предыдущего. | MUST |
| REQ-033-7 | Опрос стороннего триггера MUST идти через оркестратор (`POST /node-invocations`) со `stateKey = process:<processId>:<triggerNodeId>` и курсором задания. Успех MUST одной транзакцией ставить по запуску на каждое событие в порядке массива, сохранять курсор и сбрасывать счётчик ошибок. Ошибка MUST оставлять курсор, записывать `lastError` и увеличивать счётчик. | MUST |
| REQ-033-8 | После `PROCESS_POLL_MAX_FAILURES` ошибок опроса подряд задание MUST выключаться с причиной `poll_failed`; очередь при этом остаётся. | MUST |
| REQ-033-9 | Триггер `swag/schedule@1.0.0` MUST исполняться планировщиком без оркестратора: в момент `nextRunAt` ставится один запуск с событием `{ scheduledAt, firedAt }`, следующее время — по интервалу или cron от момента такта (4.5). Пропущенные срабатывания MUST давать один запуск. | MUST |
| REQ-033-10 | Пока в очереди задания `PROCESS_QUEUE_MAX` запусков и больше, такт MUST NOT опрашивать триггер, а ручной запуск MUST отклоняться `409 queue_full`. | MUST |
| REQ-033-11 | Запуски MUST уходить на исполнение по порядку постановки, пока у задания меньше `maxConcurrent` запусков в `launching` и `running`. Запуск MUST исполняться ровно один раз, в том числе при нескольких репликах планировщика и повторе вызова `api`. | MUST |
| REQ-033-12 | Исполнение запуска MUST идти через внутренний маршрут `api` (`POST /internal/process-runs`) тем же путём, что `POST /swarms` (`startSwarm`, 4.12): развернуть и проверить граф, зарезервировать бюджет запуска с баланса организации, `swarm.created` с `processId`, вызов оркестратора. Id исполнения MUST совпадать с id запуска, автор — автор процесса. | MUST |
| REQ-033-13 | Нехватка баланса MUST давать запуску `rejected` с причиной `insufficient_balance`, граф с замечаниями — `rejected` с причиной `invalid_graph`; задание остаётся включённым. `too_many_active_swarms` MUST возвращать запуск в очередь. | MUST |
| REQ-033-14 | Планировщик MUST сверять статусы запусков в `running` с исполнением в `api` каждый такт и переводить их в `completed`, `failed` или `stopped` с `finishedAt`. | MUST |
| REQ-033-15 | В исполнении запуска триггера нет: шаг, в который ведёт `flow` триггера, MUST получать событие как вход от id узла-триггера — программа вызовом `execute` с событием, команда сообщением от id триггера с текстом `valueText(event)`; агент-вход команды MUST получать `AGENT_TASK_FROM` = id триггера. | MUST |
| REQ-033-16 | Ручной запуск `POST /processes/:id/runs` MUST ставить событие в очередь и для выключенного процесса; при триггере событие MUST проверяться по его `outputs` (`400 invalid_event`). | MUST |
| REQ-033-17 | Узел `swag/process@1.0.0` MUST разворачиваться по 4.4 перед проверкой и исполнением — в графе процесса и в графе `POST /swarms`. Дочерний процесс MUST искаться только в организации родителя. Цикл ссылок, глубина больше `PROCESS_NEST_MAX_DEPTH`, отсутствующий процесс и слишком длинный id MUST давать замечания графа. | MUST |
| REQ-033-18 | `stateKey` программы MUST задавать `api` в `LaunchProgram.stateKey`: программа графа `POST /swarms` — `swarm:<swarmId>:<nodeId>`, программа процесса — `process:<processId>:<nodeId>`, программа из развёрнутого дочернего процесса — `process:<childProcessId>:<id в дочернем графе>`. | MUST |
| REQ-033-19 | Процесс, на который ссылается `swag/process` другого процесса организации, MUST NOT удаляться (`409 process_in_use`). | MUST |
| REQ-033-20 | Блокировка пользователя MUST выключать задания его процессов с причиной `author_blocked` и отменять их очередь, в том же обработчике, что останавливает его рои (024). | MUST |
| REQ-033-21 | При старте планировщика запуски в `launching` MUST получать `running`, если исполнение с их id есть в `api`, иначе — снова `queued`. | MUST |
| REQ-033-22 | Видимость и права процессов MUST совпадать с правилами исполнений `swarms` (024, 4.4): `user` видит и меняет свои, `admin` — своей организации, `supervisor` только видит все; чужой процесс — `404`. Запуски видны тому, кто видит процесс. | MUST |
| REQ-033-23 | Внутренний API планировщика MUST принимать только `SCHEDULER_TOKEN`, внутренние маршруты `api` — только `API_INTERNAL_TOKEN`; токен пользователя на них — `401`. | MUST |
| REQ-033-24 | Событие запуска MUST храниться только пока запуск в `queued` или `launching`, затем очищаться. Событие и курсор MUST NOT попадать в ответы публичного API (кроме задачи исполнения `task`), а событие, курсор и настройки узлов — в логи. | MUST |
| REQ-033-25 | Каждый опрос триггера и каждый запуск MUST идти в своём корневом спане планировщика (`process.poll`, `process.run`) с атрибутом `swag.process`; трейс продолжается в `api` и событиях исполнения. | MUST |
| REQ-033-26 | В организации MUST быть не больше `PROCESS_MAX_PER_ORG` процессов (`409 too_many_processes`). Недоступный планировщик MUST давать в `api` `503 scheduler_unavailable`. | MUST |
| REQ-033-27 | Исполнение из формы и из графа без `swag/process` MUST вести себя как до 033: те же события, `stateKey` программ `swarm:<swarmId>:<nodeId>`. | MUST |

## 4. Контракты

### 4.1. Процесс, задание, запуск: `packages/contracts/src/process.ts`

```ts
import { z } from 'zod';
import { ProcessGraph, NodeId } from './graph.ts';
import { NodeTypeRef } from './node.ts';
import { SecretName } from './node-invocation.ts';
import { BudgetMicroUsd, MaxTokens, OrgId, SwarmStatus } from './swarm.ts';

export const ProcessId = z.uuid();
export type ProcessId = z.infer<typeof ProcessId>;

export const PROCESS_POLL_MIN_SEC = 60;
export const PROCESS_MAX_CONCURRENT = 4;

// Определение процесса: тело POST и PUT /processes. Бюджет и maxTokens — на один запуск.
export const ProcessDraft = z.strictObject({
  name: z.string().trim().min(1).max(100),
  graph: ProcessGraph,
  budgetMicroUsd: BudgetMicroUsd,
  maxTokens: MaxTokens.nullable().default(null),
  pollIntervalSec: z.number().int().min(PROCESS_POLL_MIN_SEC).max(86_400).default(300), // swag/schedule не использует
  maxConcurrent: z.number().int().min(1).max(PROCESS_MAX_CONCURRENT).default(1),
});
export type ProcessDraft = z.infer<typeof ProcessDraft>;

// --- задание: api → планировщик ---

export const JobTrigger = z.strictObject({
  nodeId: NodeId,
  type: NodeTypeRef,
  settings: z.record(z.string(), z.unknown()), // после validateSettings
  credentials: z.record(z.string(), SecretName),
});
export type JobTrigger = z.infer<typeof JobTrigger>;

// Тело PUT /jobs/:processId.
export const JobSpec = z.strictObject({
  orgId: OrgId,
  createdBy: z.uuid(),
  trigger: JobTrigger.nullable(), // null — процесс без триггера: только ручной запуск
  pollIntervalSec: z.number().int().min(PROCESS_POLL_MIN_SEC).max(86_400),
  maxConcurrent: z.number().int().min(1).max(PROCESS_MAX_CONCURRENT),
});
export type JobSpec = z.infer<typeof JobSpec>;

export const JobDisabledReason = z.enum(['user', 'poll_failed', 'author_blocked']);
export type JobDisabledReason = z.infer<typeof JobDisabledReason>;

export const JobDisableRequest = z.strictObject({ reason: z.enum(['user', 'author_blocked']) });
export type JobDisableRequest = z.infer<typeof JobDisableRequest>;

export const JobError = z.strictObject({
  code: z.string().max(64), // NodeInvocationErrorCode, orchestrator_unavailable, schedule_exhausted
  message: z.string().max(1000),
  at: z.iso.datetime(),
});
export type JobError = z.infer<typeof JobError>;

export const JobState = z.strictObject({
  processId: ProcessId,
  enabled: z.boolean(),
  disabledReason: JobDisabledReason.nullable(), // null у включённого и у нового
  nextRunAt: z.iso.datetime().nullable(), // null у выключенного
  lastPollAt: z.iso.datetime().nullable(),
  lastError: JobError.nullable(),
  consecutiveFailures: z.number().int().min(0),
  queued: z.number().int().min(0), // запусков в queued и launching
  running: z.number().int().min(0), // запусков в running
});
export type JobState = z.infer<typeof JobState>;

export const JobStatesRequest = z.strictObject({ processIds: z.array(ProcessId).max(200) });
export const JobStateList = z.strictObject({ items: z.array(JobState) }); // только найденные задания

// --- запуск процесса ---

export const RunStatus = z.enum(['queued', 'launching', 'running', 'completed', 'failed', 'stopped', 'rejected', 'cancelled']);
export type RunStatus = z.infer<typeof RunStatus>;

export const RunRejectReason = z.enum(['insufficient_balance', 'invalid_graph']);
export type RunRejectReason = z.infer<typeof RunRejectReason>;

export const RunSource = z.enum(['trigger', 'manual']);
export type RunSource = z.infer<typeof RunSource>;

// Тело POST /processes/:id/runs (публичное) и POST /jobs/:processId/runs (планировщик, source всегда manual).
export const RunRequest = z.strictObject({ event: z.unknown() });
export type RunRequest = z.infer<typeof RunRequest>;

export const ProcessRunView = z.strictObject({
  id: z.uuid(), // = swarmId исполнения
  processId: ProcessId,
  status: RunStatus,
  reason: RunRejectReason.nullable(), // только у rejected
  source: RunSource,
  createdAt: z.iso.datetime(),
  launchedAt: z.iso.datetime().nullable(),
  finishedAt: z.iso.datetime().nullable(),
});
export type ProcessRunView = z.infer<typeof ProcessRunView>;

export const ProcessRunList = z.strictObject({ items: z.array(ProcessRunView) }); // createdAt по убыванию, не больше 50
export type ProcessRunList = z.infer<typeof ProcessRunList>;

// --- внутренний API api для планировщика ---

export const RunLaunchRequest = z.strictObject({ runId: z.uuid(), processId: ProcessId, event: z.unknown() });
export type RunLaunchRequest = z.infer<typeof RunLaunchRequest>;

export const RunLaunchResult = z.discriminatedUnion('outcome', [
  z.strictObject({ outcome: z.literal('launched') }), // в том числе исполнение с этим id уже есть
  z.strictObject({ outcome: z.literal('rejected'), reason: RunRejectReason }),
  z.strictObject({ outcome: z.literal('busy') }), // too_many_active_swarms
  z.strictObject({ outcome: z.literal('process_not_found') }),
]);
export type RunLaunchResult = z.infer<typeof RunLaunchResult>;

export const RunStatusRequest = z.strictObject({ runIds: z.array(z.uuid()).max(200) });
export const RunStatusList = z.strictObject({
  items: z.array(z.strictObject({ runId: z.uuid(), status: SwarmStatus.nullable() })), // null — исполнения нет
});

// --- публичное представление процесса в api ---

export const ProcessView = z.strictObject({
  id: ProcessId,
  orgId: OrgId,
  createdBy: z.uuid(),
  definition: ProcessDraft, // после разбора: с умолчаниями
  trigger: z.strictObject({ nodeId: NodeId, type: NodeTypeRef }).nullable(),
  job: JobState.omit({ processId: true }),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type ProcessView = z.infer<typeof ProcessView>;

export const ProcessSummary = z.strictObject({
  id: ProcessId,
  orgId: OrgId,
  createdBy: z.uuid(),
  name: z.string(),
  trigger: ProcessView.shape.trigger,
  job: ProcessView.shape.job,
  updatedAt: z.iso.datetime(),
});
export const ProcessList = z.strictObject({ items: z.array(ProcessSummary) }); // updatedAt по убыванию
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

// Вход шага-входа от триггера запуска (REQ-033-15). null — задача пользователя, как в 009.
export const LaunchTrigger = z.strictObject({ nodeId: NodeId, event: z.unknown() });

export const SwarmLaunch = z.strictObject({
  // …поля 009 без изменений…
  trigger: LaunchTrigger.nullable().default(null),
});
```

`stateKey` и `trigger` необязательны, чтобы оркестратор и `api` менялись разными этапами; `api` после 033 передаёт оба поля всегда.

`swarm.created.data` (`events.ts`) получает `processId: ProcessId.nullable().optional()`: у `POST /swarms` — `null`, у запуска процесса — id процесса. `SwarmView` (`api-integration/src/swarm-view.ts`) получает `processId: string | null` из `swarm.created`; без поля — `null`.

### 4.3. Граф процесса: `checkGraph` с триггером и `launchGraph`

```ts
// packages/api-integration/src/process-graph.ts
export interface GraphCheckDeps {
  registry: NodeRegistry;
  secretNames: ReadonlySet<string>;
  triggers?: boolean; // true — граф процесса (033); по умолчанию false — граф POST /swarms (009)
}
```

`GraphIssueCode` (`graph.ts`) получает `trigger_not_entry`, `trigger_flow`, `process_not_found`, `process_cycle`, `process_too_deep`, `process_node_id_too_long`, `process_invalid`.

При `triggers: true` узел вида `trigger` в проходе 1 допустим, в проходах 2–5 он **шаг-триггер**: шаг, который даёт значение и не принимает его. Правила сверх 009, 4.4:
- проход 2: настройки и `credentials` проверяются, как у программы;
- проход 4: триггер не `entry` — `trigger_not_entry`, путь `nodes.<i>`; у триггера-входа не ровно одно исходящее `flow` — `trigger_flow`, путь `nodes.<i>`; `link` с триггером — `link_requires_agents`;
- проход 5: `exit` — триггер — `exit_not_step`, путь `exit`.

Без `triggers` узел `trigger` по-прежнему `node_kind_unsupported`.

```ts
// Граф исполнения: без триггера и его flow; entry — цель flow триггера. Вход — граф без замечаний checkGraph.
export function launchGraph(graph: ProcessGraph, registry: NodeRegistry): {
  graph: ProcessGraph;
  trigger: JobTrigger | null; // настройки после validateSettings
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

// rootId — id процесса корневого графа (null у POST /swarms); children — графы процессов организации по id.
export function expandGraph(graph: ProcessGraph, children: ReadonlyMap<string, ProcessGraph>, rootId: string | null): ExpandResult;
```

Алгоритм для узла `p` с `type = PROCESS_NODE_TYPE` и `settings.processId = c`, узлы по порядку массива, рекурсивно с глубины 1:
1. `c` нет в `children` — `process_not_found`, путь `nodes.<i>.settings.processId`. `c` уже на пути от корня (включая `rootId`) — `process_cycle`, тот же путь. Глубина узла больше `PROCESS_NEST_MAX_DEPTH - 1` — `process_too_deep`, тот же путь.
2. Граф `c` сначала разворачивается сам. Замечания внутри него — одно `process_invalid` на узел `p` с сообщением `<code> at <path>` первого замечания.
3. Если в графе `c` есть триггер, он и его `flow` убираются (`launchGraph`); вход `c` — цель его `flow`, иначе `entry` графа `c`. Выход `c` — `exit` графа `c`.
4. Узлы `c` получают id `<p>-<id>` в порядке их графа и встают в массив узлов на место `p`. Id длиннее 40 символов (не `NodeId`) — `process_node_id_too_long`, путь `nodes.<i>.id`.
5. Рёбра `c` переименовываются так же и добавляются в конец массива рёбер. Входящие `flow` родителя в `p` ведут в `<p>-<вход c>`, исходящие идут из `<p>-<выход c>`. `entry` или `exit` родителя, равные `p`, — `<p>-<вход c>` и `<p>-<выход c>`.
6. `origin` узла из `c` — `{ processId: c, nodeId: id в графе c }`; при нескольких уровнях — самый внутренний процесс.

Бюджет, `maxTokens`, `maxConcurrent` и включённость дочернего процесса не используются: развёрнутые узлы исполняются в исполнении родителя, в его бюджете и `SWARM_TIMEOUT_MS`.

### 4.5. Триггер-расписание: `swag/schedule@1.0.0` и `CronSchedule`

Пакет `packages/node-schedule` (`@swag/node-schedule`), по образцу `@swag/node-llm-agent`:

```ts
export default defineNode({
  type: 'swag/schedule',
  version: '1.0.0',
  kind: 'trigger',
  title: 'Расписание',
  description: 'Запуск процесса по интервалу или по cron. Исполняется планировщиком, без песочницы.',
  settings: z.strictObject({
    everySec: z.number().int().min(60).max(604_800).nullable().default(null),
    cron: z.string().trim().min(1).max(100).nullable().default(null), // 5 полей: минута час день месяц день-недели
    timezone: z.string().min(1).max(64).default('UTC'), // IANA
  }),
  outputs: z.strictObject({ scheduledAt: z.iso.datetime(), firedAt: z.iso.datetime() }),
  poll: async () => { throw new Error('swag/schedule is run by the scheduler'); },
});
```

Порт `CronSchedule` объявляют оба ядра — `api-core` (проверка при сохранении) и `scheduler-core` (время срабатывания):

```ts
export interface CronSchedule {
  check(cron: string, timezone: string): 'ok' | 'invalid_cron' | 'invalid_timezone';
  next(cron: string, timezone: string, after: Date): Date | null; // первое срабатывание строго после after
}
export const SCHEDULE_TRIGGER_TYPE = 'swag/schedule@1.0.0'; // в api-integration, общая константа обоих ядер
```

Адаптер — `packages/adapter-croner`, `createCronerSchedule(): CronSchedule` на `croner@9.1.0`, 5 полей без секунд.

Проверка `api` при сохранении (после `checkGraph`), по замечанию `invalid_settings`:
- заданы оба `everySec` и `cron` или ни одного — путь `nodes.<i>.settings`, сообщение `set exactly one of everySec and cron`;
- `check` = `invalid_cron` — путь `nodes.<i>.settings.cron`; `invalid_timezone` — путь `nodes.<i>.settings.timezone`.

`nextScheduleRun(settings, after)` в `scheduler-core`: `everySec` — `after + everySec`; `cron` — `next(cron, timezone, after)`; `null` — задание выключается с `poll_failed` и `lastError { code: 'schedule_exhausted' }`.

### 4.6. Порты `api-core`

```ts
export interface ProcessRecord {
  id: string;
  orgId: string;
  createdBy: string;
  definition: ProcessDraft;
  createdAt: string;
  updatedAt: string;
}

export interface ProcessStore {
  create(record: ProcessRecord): Promise<void>;
  update(record: ProcessRecord): Promise<void>; // целиком, по id
  get(id: string): Promise<ProcessRecord | null>;
  list(orgId: string | null): Promise<ProcessRecord[]>; // null — все организации
  count(orgId: string): Promise<number>;
  delete(id: string): Promise<boolean>;
}

// Клиент внутреннего API планировщика (4.9). Сеть и не-2xx, кроме перечисленных результатов, — исключение.
export interface SchedulerClient {
  putJob(processId: string, spec: JobSpec): Promise<JobState>;
  enable(processId: string): Promise<JobState | 'not_found' | 'process_no_trigger'>;
  disable(processId: string, reason: 'user' | 'author_blocked'): Promise<JobState | 'not_found'>;
  deleteJob(processId: string): Promise<void>; // 404 — не ошибка
  states(processIds: readonly string[]): Promise<JobState[]>;
  createRun(processId: string, event: unknown): Promise<ProcessRunView | 'not_found' | 'queue_full'>;
  runs(processId: string): Promise<ProcessRunView[]>;
}

export interface CronSchedule { /* 4.5 */ }
```

`ApiCoreDeps` получает `processes: ProcessStore`, `scheduler: SchedulerClient`, `cron: CronSchedule`, а `limits` — `processMaxPerOrg`. `OrchestratorClient` не меняется.

### 4.7. Ядро планировщика: `packages/scheduler-core`

Пакет по правилам ядра (docs/architecture.md): только `zod`, `@swag/contracts`, `@swag/api-integration`.

```ts
export interface JobRecord {
  processId: string;
  spec: JobSpec;
  enabled: boolean;
  disabledReason: JobDisabledReason | null;
  cursor: string | null;
  nextRunAt: string | null;
  lastPollAt: string | null;
  lastError: JobError | null;
  consecutiveFailures: number;
  updatedAt: string;
}

export interface RunRecord {
  id: string;
  processId: string;
  orgId: string;
  status: RunStatus;
  reason: RunRejectReason | null;
  source: RunSource;
  event: unknown; // null вне queued и launching
  createdAt: string;
  launchedAt: string | null;
  finishedAt: string | null;
}

// Результат такта по заданию: одной транзакцией, снимает аренду.
export interface TickRecord {
  cursor: string | null;
  nextRunAt: string | null;
  lastPollAt: string | null;
  lastError: JobError | null;
  consecutiveFailures: number;
  enabled: boolean;
  disabledReason: JobDisabledReason | null;
  enqueue: RunRecord[];
}

export interface JobStore {
  put(record: JobRecord): Promise<void>; // создать или заменить целиком
  get(processId: string): Promise<JobRecord | null>;
  getMany(processIds: readonly string[]): Promise<JobRecord[]>;
  delete(processId: string): Promise<boolean>; // запуски — каскадом
  claimDue(now: string, leaseUntil: string, limit: number): Promise<JobRecord[]>; // enabled, nextRunAt <= now, аренды нет или истекла; по nextRunAt
  recordTick(processId: string, tick: TickRecord): Promise<void>;
  enqueue(run: RunRecord): Promise<void>;
  counts(processIds: readonly string[]): Promise<Map<string, { queued: number; running: number }>>; // queued = queued + launching
  takeQueued(limit: number): Promise<RunRecord[]>; // queued → launching атомарно, по createdAt
  setRun(id: string, patch: { status: RunStatus; reason?: RunRejectReason | null; launchedAt?: string; finishedAt?: string }): Promise<void>; // статус вне queued и launching — event = null
  cancelQueued(processId: string): Promise<number>;
  byStatus(status: 'launching' | 'running', limit: number): Promise<RunRecord[]>;
  runs(processId: string, limit: number): Promise<RunRecord[]>; // createdAt по убыванию
}

// Внутренние маршруты api (4.10). Сеть и не-2xx — исключение.
export interface ApiClient {
  launchRun(request: RunLaunchRequest): Promise<RunLaunchResult>;
  runStatuses(runIds: readonly string[]): Promise<Map<string, SwarmStatus | null>>;
}

export interface NodeInvoker {
  invokeNode(invocation: NodeInvocation): Promise<NodeInvocationResult>; // POST /node-invocations оркестратора
}

export interface RootSpans {
  run<T>(name: 'process.poll' | 'process.run', attributes: { 'swag.process': string }, fn: () => Promise<T>): Promise<T>;
}

export interface SchedulerCoreDeps {
  jobs: JobStore;
  api: ApiClient;
  nodes: NodeInvoker;
  cron: CronSchedule;
  spans: RootSpans;
  clock: Clock;
  ids: IdGenerator;
  log: Logger;
  limits: { queueMax: number; pollMaxFailures: number; leaseMs: number; pollTimeoutMs: number };
}

export const PROCESS_TICK_BATCH = 20;

export interface SchedulerCore {
  putJob(processId: string, spec: JobSpec): Promise<JobState>;
  enable(processId: string): Promise<JobState | 'not_found' | 'process_no_trigger'>;
  disable(processId: string, reason: 'user' | 'author_blocked'): Promise<JobState | 'not_found'>;
  deleteJob(processId: string): Promise<boolean>;
  states(processIds: readonly string[]): Promise<JobState[]>;
  createRun(processId: string, event: unknown): Promise<ProcessRunView | 'not_found' | 'queue_full'>;
  runs(processId: string): Promise<ProcessRunView[] | 'not_found'>;
  tick(): Promise<{ polled: number; enqueued: number; launched: number; synced: number }>;
  recover(): Promise<number>;
}

export function createSchedulerCore(deps: SchedulerCoreDeps): SchedulerCore;
```

Операции заданий:
- **`putJob`** — нет задания: `enabled: false`, `disabledReason: null`, курсор и времена `null`, счётчик 0. Есть: `spec` заменяется; триггер изменился (сравнение `JobTrigger` целиком) — курсор `null`; включённое — `nextRunAt` по правилу `enable`.
- **`enable`** — `spec.trigger = null` — `process_no_trigger`. `enabled: true`, `disabledReason: null`, `consecutiveFailures: 0`, `lastError: null`; `nextRunAt` — сейчас у стороннего триггера, `nextScheduleRun(settings, сейчас)` у `swag/schedule`. Уже включённое — без изменений.
- **`disable`** — `enabled: false`, `disabledReason: reason`, `nextRunAt: null`, `cancelQueued`.
- **`createRun`** — `counts.queued ≥ queueMax` — `queue_full`; иначе `enqueue { status: 'queued', source: 'manual' }`.
- `JobState.queued` и `running` — из `counts`.

### 4.8. Хранение: `packages/adapter-postgres/migrations/0007_processes.sql`

```sql
-- Up Migration
create table processes (
  id uuid primary key,
  org_id uuid not null references organizations (id),
  created_by uuid not null references users (id),
  definition jsonb not null,
  created_at timestamptz not null,
  updated_at timestamptz not null
);
create index processes_org_idx on processes (org_id, updated_at desc);

create table scheduler_jobs (
  process_id uuid primary key, -- без внешнего ключа: processes принадлежит api
  spec jsonb not null,
  enabled boolean not null,
  disabled_reason text null,
  cursor text null,
  next_run_at timestamptz null,
  lease_until timestamptz null,
  last_poll_at timestamptz null,
  last_error jsonb null,
  consecutive_failures integer not null,
  updated_at timestamptz not null
);
create index scheduler_jobs_due_idx on scheduler_jobs (next_run_at) where enabled;

create table process_runs (
  id uuid primary key,
  process_id uuid not null references scheduler_jobs (process_id) on delete cascade,
  org_id uuid not null,
  status text not null,
  reason text null,
  source text not null,
  event jsonb null,
  created_at timestamptz not null,
  launched_at timestamptz null,
  finished_at timestamptz null
);
create index process_runs_queue_idx on process_runs (created_at) where status = 'queued';
create index process_runs_process_idx on process_runs (process_id, created_at desc);

-- Down Migration
drop table process_runs;
drop table scheduler_jobs;
drop table processes;
```

Таблицу `processes` пишет только `api` (`createPostgresProcessStore`), `scheduler_jobs` и `process_runs` — только планировщик (`createPostgresJobStore`).
- `claimDue` — `update scheduler_jobs set lease_until = $2 where process_id in (select process_id from scheduler_jobs where enabled and next_run_at <= $1 and (lease_until is null or lease_until < $1) order by next_run_at limit $3 for update skip locked) returning *`.
- `recordTick` — одна транзакция: `update scheduler_jobs` полями `TickRecord`, `lease_until = null`; `insert` запусков `enqueue`.
- `takeQueued` — `update process_runs set status = 'launching' where id in (select id … where status = 'queued' order by created_at limit $1 for update skip locked) returning *`.

### 4.9. Внутренний API планировщика: `apps/scheduler`

Все маршруты, кроме `GET /health`, — с `authorization: Bearer <SCHEDULER_TOKEN>`; иначе `401 unauthorized` (как у оркестратора, `bearerMatches`).

| Метод и путь | Тело | Ответ | Ошибки |
|---|---|---|---|
| `GET /health` | — | `200 { status: 'ok', … }` | — |
| `PUT /jobs/:processId` | `JobSpec` | `200 JobState` | `400 invalid_request` |
| `POST /jobs/:processId/enable` | — | `200 JobState` | `404 job_not_found`, `409 process_no_trigger` |
| `POST /jobs/:processId/disable` | `JobDisableRequest` | `200 JobState` | `400`, `404 job_not_found` |
| `DELETE /jobs/:processId` | — | `204` | `404 job_not_found` |
| `POST /jobs/states` | `JobStatesRequest` | `200 JobStateList` | `400` |
| `POST /jobs/:processId/runs` | `RunRequest` | `201 ProcessRunView` | `400`, `404 job_not_found`, `409 queue_full` |
| `GET /jobs/:processId/runs` | — | `200 ProcessRunList` | `404 job_not_found` |

Клиент для `api` — `packages/adapter-scheduler-http`, `createSchedulerHttpClient({ baseUrl, token, timeoutMs }): SchedulerClient`, `traceparent` — как в `adapter-orchestrator-http`; `timeoutMs` — константа `10000` в оболочке `api`.

### 4.10. Внутренние маршруты `api`

С `authorization: Bearer <API_INTERNAL_TOKEN>`, без токена пользователя; иначе `401 unauthorized`. Хук проверки токена пользователя для префикса `/internal/` не применяется.

| Метод и путь | Тело | Ответ | Ошибки |
|---|---|---|---|
| `POST /internal/process-runs` | `RunLaunchRequest` | `200 RunLaunchResult` | `400 validation_error`, `401` |
| `POST /internal/process-runs/status` | `RunStatusRequest` | `200 RunStatusList` | `400 validation_error`, `401` |

`launchRun` (`api-core`):
1. Исполнение с id `runId` уже есть (`store.view`) — `launched`.
2. Процесса нет — `process_not_found`.
3. `startSwarm` (4.12) с `swarmId = runId`, автором и `orgId` процесса, `processId`, бюджетом и `maxTokens` определения, `trigger { event }`: успех и сбой оркестратора (исполнение `failed`, 009) — `launched`; `insufficient_balance`, `invalid_graph` — `rejected` с причиной; `too_many_active_swarms` — `busy`.

`runStatuses` — `status` из `store.view(runId)` или `null`.

Клиент для планировщика — `packages/adapter-api-http`, `createApiInternalHttpClient({ baseUrl, token, timeoutMs }): ApiClient`. `NodeInvoker` — `invokeNode` в `packages/adapter-orchestrator-http`: `POST /node-invocations` с `ORCHESTRATOR_TOKEN` и `traceparent`, таймаут запроса — `invocation.timeoutMs + 10000`. `RootSpans` — `createRootSpans(telemetry)` в `packages/adapter-telemetry` (спан без родителя, контекст активен на время `fn`).

### 4.11. Публичный API процессов в `api`

| Метод и путь | Право | Тело | Ответ | Ошибки |
|---|---|---|---|---|
| `POST /processes` | `process.manage` | `ProcessDraft` | `201 ProcessView` | `400 validation_error`, `400 invalid_graph`, `403`, `409 too_many_processes`, `503 scheduler_unavailable` |
| `GET /processes` | `process.read` | — | `200 ProcessList` (видимые) | `403`, `503` |
| `GET /processes/:id` | `process.read` | — | `200 ProcessView` | `403`, `404`, `503` |
| `PUT /processes/:id` | `process.manage` | `ProcessDraft` | `200 ProcessView` | как `POST` + `404` |
| `DELETE /processes/:id` | `process.manage` | — | `204` | `403`, `404`, `409 process_in_use`, `503` |
| `POST /processes/:id/enable` | `process.manage` | — | `200 ProcessView` | `400 invalid_graph`, `403`, `404`, `409 process_no_trigger`, `503` |
| `POST /processes/:id/disable` | `process.manage` | — | `200 ProcessView` | `403`, `404`, `503` |
| `POST /processes/:id/runs` | `process.manage` | `RunRequest` | `202 ProcessRunView` | `400 validation_error`, `400 invalid_event`, `403`, `404`, `409 queue_full`, `503` |
| `GET /processes/:id/runs` | `process.read` | — | `200 ProcessRunList` | `403`, `404`, `503` |

`app.ts` `STATUS`: `invalid_event: 400`, `process_no_trigger: 409`, `process_in_use: 409`, `too_many_processes: 409`, `queue_full: 409`, `scheduler_unavailable: 503`. Исключение `SchedulerClient` — `scheduler_unavailable`.

Операции `api-core` (видимость `visibleProcess` — функция `visible` 024 по `orgId` и `createdBy` процесса; `actor.orgId === null` у `POST` — `403 forbidden`):
- **`checkProcessDraft(orgId, id, draft)`** (REQ-033-2): бюджеты → `checkGraph(graph, { …, triggers: true })` → `invalid_settings` расписания (4.5) → `expandGraph` (дочерние графы — `processes.list(orgId)`, `rootId = id`) → `checkGraph` развёрнутого графа с `triggers: true`, у замечаний путь с префиксом `expanded.`.
- **`jobSpec(record)`** — `JobSpec` из определения: `trigger` из `launchGraph`, `pollIntervalSec`, `maxConcurrent`, `orgId`, `createdBy`.
- **`createProcess`** — разбор, лимит `PROCESS_MAX_PER_ORG`, `checkProcessDraft`, `id = ids.uuid()`, `scheduler.putJob`, затем `processes.create`; сбой записи — `scheduler.deleteJob` без ожидания результата и исключение.
- **`updateProcess`** — разбор, `checkProcessDraft`, `scheduler.putJob`, затем `processes.update`. Повтор `PUT` после `503` приводит задание и определение к одному состоянию.
- **`deleteProcess`** — есть процесс организации с `swag/process`, `settings.processId` которого равен id, — `409 process_in_use`; иначе `scheduler.deleteJob`, затем `processes.delete`.
- **`enableProcess`** — нет триггера — `409 process_no_trigger`; `checkProcessDraft` — `400 invalid_graph`; `scheduler.enable`.
- **`disableProcess`** — `scheduler.disable(id, 'user')`.
- **`runProcess`** — разбор `RunRequest`; при триггере `registry.validate(type, { place: 'outputs' }, event)` не `ok` — `400 invalid_event` с замечаниями; `scheduler.createRun` (`queue_full` — `409`).
- **`listProcessRuns`** — `scheduler.runs`.
- **`disableProcessesOfUser(userId)`** — по каждому процессу автора `scheduler.disable(id, 'author_blocked')`. Вызывается в `createBlockHandler` (`apps/api/src/streams.ts`) после `stopSwarmsOfUser`.
- `ProcessView.job` — из `scheduler.states`; задания нет — `{ enabled: false, disabledReason: null, nextRunAt: null, lastPollAt: null, lastError: null, consecutiveFailures: 0, queued: 0, running: 0 }`.

### 4.12. Общий путь исполнения: `startSwarm`

`createSwarm` (009, 4.9) делится на разбор запроса и общий `startSwarm`; поведение `POST /swarms` не меняется, кроме разворачивания `swag/process`.

```ts
interface StartSwarm {
  swarmId: string;
  orgId: string;
  createdBy: string;
  processId: string | null;
  task: string; // у запуска процесса — valueText(event), обрезанный до 4000 символов
  graph: ProcessGraph; // у POST /swarms — из запроса, у запуска — определение процесса
  trigger: { event: unknown } | null; // только у запуска процесса
  budgetMicroUsd: number;
  maxTokens: number | null;
}
```

1. `expandGraph(graph, процессы организации, processId)`; `checkGraph` с `triggers: processId !== null`; у `POST /swarms` ещё `entry_input_invalid` (009). Замечания — `invalid_graph`.
2. `launchGraph` — граф исполнения и триггер; `SwarmLaunch.trigger` — `{ nodeId: триггер.nodeId, event }` при `trigger`, иначе `null`.
3. `launchNodes` (009) по графу исполнения; `stateKey` каждой программы — по REQ-033-18 через `origin`.
4. Лимит активных исполнений, резерв, `swarm.created` (с `processId`), `launch` — как в 009.

`createSwarm` вызывает `startSwarm` с `swarmId = ids.uuid()`, автором `actor.userId`, `processId: null`, `trigger: null`.

### 4.13. Такт планировщика

Оболочка `apps/scheduler` при старте вызывает `recover`, затем `tick` цепочкой `setTimeout(PROCESS_TICK_MS)`: следующий вызов — после окончания предыдущего; исключение такта — лог `process_tick_failed` с `errorName`, цепочка продолжается. Остановка сервиса дожидается текущего такта.

Шаги `tick` (`now = clock.now()`):
1. **Захват.** `claimDue(now, now + leaseMs, PROCESS_TICK_BATCH)`.
2. **Опрос** каждого захваченного задания — в `spans.run('process.poll', …)`:
   - `counts.queued ≥ queueMax` — `recordTick` с прежним курсором, `nextRunAt = now + pollIntervalSec` (у `swag/schedule` — прежний `nextRunAt`: он остаётся в прошлом и даст догоняющее срабатывание), без запусков;
   - `swag/schedule` — запуск с событием `{ scheduledAt: nextRunAt, firedAt: now }`, `nextRunAt = nextScheduleRun(settings, now)`;
   - сторонний триггер — `nodes.invokeNode({ orgId, type, call: { kind: 'poll', cursor }, settings, credentials, stateKey: 'process:<processId>:<triggerNodeId>', timeoutMs: pollTimeoutMs })`. `ok` — запуск на каждое событие `output.events`, курсор `output.cursor`, `consecutiveFailures: 0`, `lastError: null`. Не `ok` — `lastError { code: error.code, message: error.message, at: now }`; исключение клиента — `lastError { code: 'orchestrator_unavailable', message: 'orchestrator is unavailable', at: now }`; курсор прежний, счётчик + 1; счётчик достиг `pollMaxFailures` — `enabled: false`, `disabledReason: 'poll_failed'`, `nextRunAt: null`. Иначе `nextRunAt = now + pollIntervalSec`; `lastPollAt = now`;
   - всё — одним `recordTick`. Запуски: `{ id: ids.uuid(), status: 'queued', source: 'trigger', event, createdAt: now }`.
3. **Запуск.** `takeQueued(PROCESS_TICK_BATCH)`; по каждому — в `spans.run('process.run', …)`:
   - у задания `running + запущенные в этом такте ≥ maxConcurrent` — `setRun(id, { status: 'queued' })`;
   - `api.launchRun({ runId, processId, event })`: `launched` — `running`, `launchedAt = now`; `rejected` — `rejected` с причиной; `process_not_found` — `cancelled`; `busy` или исключение — этот и оставшиеся взятые запуски снова `queued`, шаг 3 заканчивается (исключение — лог `process_run_launch_failed` с `errorName`).
4. **Сверка.** `byStatus('running', 200)` → `api.runStatuses`: `completed`, `failed`, `stopped` — тот же статус запуска и `finishedAt = now`; `starting`, `running`, `null` — без изменений; исключение — лог, шаг пропускается.

`recover`: `byStatus('launching', 200)` → `api.runStatuses`: статус не `null` — `running` (финальный — сразу финальный с `finishedAt`), `null` — `queued`.

### 4.14. Сервис и конфиг

`SchedulerConfig` (`packages/config`, расширяет `BaseConfig`):

| Переменная | Тип | По умолчанию |
|---|---|---|
| `SCHEDULER_PORT` | `Port` | — (в `.env.example` 3004) |
| `SCHEDULER_TOKEN` | строка ≥ 32 | — |
| `API_URL` | url | — (`http://api:3000`) |
| `API_INTERNAL_TOKEN` | строка ≥ 32 | — |
| `ORCHESTRATOR_URL`, `ORCHESTRATOR_TOKEN` | как у `api` | — |
| `PROCESS_TICK_MS` | int ≥ 1000 | 5000 |
| `PROCESS_LEASE_MS` | int ≥ 10000 | 120000 |
| `PROCESS_POLL_TIMEOUT_MS` | int 1000…300000 | 30000 |
| `PROCESS_QUEUE_MAX` | int ≥ 1 | 20 |
| `PROCESS_POLL_MAX_FAILURES` | int ≥ 1 | 10 |

`PROCESS_LEASE_MS` MUST быть больше `PROCESS_POLL_TIMEOUT_MS + 10000` — иначе ошибка конфига при старте.

`ApiConfig` получает `SCHEDULER_URL` (url, `http://scheduler:3004`), `SCHEDULER_TOKEN`, `API_INTERNAL_TOKEN` (строки ≥ 32) и `PROCESS_MAX_PER_ORG` (int ≥ 1, по умолчанию 50).

`compose.yaml` — сервис `scheduler` по образцу `orchestrator` (сборка, `depends_on` на `postgres`, `api`, `orchestrator`, порт только на `127.0.0.1`, OTLP). Миграции запускает тот же сервис, что сейчас. Переменные — в `.env.example` и локальный `.env` с dev-значениями `swag-local-…-not-secret-000`. `NODE_PACKAGES` по умолчанию (`compose.yaml` у `api` и `orchestrator`, `.env.example`, `.env`) получает `@swag/node-schedule,@swag/node-process`; пакеты — в зависимости `apps/api`, как `@swag/node-example`. В `apps/node-host` они не нужны.

## 5. Критерии приёмки

- **AC-033-1** — *Given* `ProcessDraft` без необязательных полей *When* разбор *Then* `maxTokens: null`, `pollIntervalSec: 300`, `maxConcurrent: 1`; `pollIntervalSec: 59` и `maxConcurrent: 5` отклоняются. `ROLE_PERMISSIONS`: `user` и `admin` — `process.read` и `process.manage`, `supervisor` — только `process.read`.
- **AC-033-2** — *Given* граф `t (swag/schedule) → a (агент)`, `entry = t`, `exit = a` *When* `checkGraph` с `triggers: true` *Then* `ok`; *When* без опции *Then* `node_kind_unsupported` у `t`.
- **AC-033-3** — *Given* (отдельные графы) триггер не `entry`; триггер-вход с двумя исходящими `flow`; триггер-вход без `flow`; `exit = t` *When* `checkGraph` с `triggers: true` *Then* среди замечаний — `trigger_not_entry`; `trigger_flow`; `trigger_flow`; `exit_not_step`.
- **AC-033-4** — *Given* граф AC-033-2 *When* `launchGraph` *Then* граф из одного `a`, `entry = exit = a`, без рёбер; `trigger.nodeId = 't'` с настройками после умолчаний; граф без триггера — как есть, `trigger: null`.
- **AC-033-5** — *Given* родитель `e (echo) → p (swag/process → C)`, `C` — `t → x (echo) → y (echo)`, `entry = e`, `exit = p` *When* `expandGraph` *Then* узлы `e`, `p-x`, `p-y` (триггер `C` убран), рёбра `p-x → p-y`, `e → p-x`, `exit = p-y`; `origin['p-x'] = { processId: C, nodeId: 'x' }`, `origin.e = null`.
- **AC-033-6** — *Given* `swag/process` на отсутствующий процесс; на сам корень (`rootId`); цепочка глубины 4; дочерний узел с id в 38 символов при `p` в 5 символов; дочерний процесс, который ссылается на отсутствующий *When* `expandGraph` *Then* `process_not_found`; `process_cycle`; `process_too_deep`; `process_node_id_too_long`; `process_invalid` с сообщением `process_not_found at nodes.<i>.settings.processId` — пути по 4.4.
- **AC-033-7** — *Given* `SwarmLaunch` без `trigger` и `stateKey` *When* разбор и исполнение *Then* `trigger: null`, программа вызывается со `stateKey = swarm:<id>:<nodeId>`; программа со `stateKey: 'process:c:x'` — вызов с ним (REQ-033-27).
- **AC-033-8** — *Given* `SwarmLaunch` с `trigger { nodeId: 't', event: { n: 1 } }`, шаг-вход — программа `p` *When* все агенты стартовали *Then* `execute` с входом `{ n: 1 }`. *Given* шаг-вход — команда `a` *Then* сообщение шины `from: 't'`, `to: 'a'`, `text: '{"n":1}'`, env `a` — `AGENT_TASK_FROM=t`.
- **AC-033-9** — *Given* `swarm.created` с `processId` и без поля *When* проекция *Then* `SwarmView.processId` — id и `null`.
- **AC-033-10** — *Given* `swag/schedule` с `cron: '0 9 * * *'`, `timezone: 'Europe/Moscow'` *When* `next` после `2026-11-03T10:00:00Z` *Then* `2026-11-04T06:00:00.000Z`; `check('bad', 'UTC')` — `invalid_cron`, `check('* * * * *', 'Mars/Base')` — `invalid_timezone` (тест `adapter-croner`).
- **AC-033-11** — *Given* набор тестов хранилища заданий и процессов *When* прогон на адаптере в памяти и на Postgres (стек-тест) *Then* одинаковое поведение: `put`, `claimDue` (аренда, `skip locked` двумя соединениями), `recordTick` (курсор и запуски одной транзакцией), `takeQueued`, `setRun` (очистка `event`), `counts`, каскадное удаление; CRUD `ProcessStore`.
- **AC-033-12** — *Given* `putJob` нового задания *Then* `enabled: false`, `nextRunAt: null`. *Given* включённое задание с курсором `c1` *When* `putJob` (1) с другим `maxConcurrent`, (2) с другими настройками триггера *Then* (1) курсор `c1`, (2) курсор `null` и `nextRunAt` пересчитан.
- **AC-033-13** — *Given* задание без триггера *When* `enable` *Then* `process_no_trigger`. *Given* `swag/schedule` `everySec: 60` *When* `enable` в `10:00:00` *Then* `nextRunAt = 10:01:00`; сторонний триггер — `nextRunAt = 10:00:00`.
- **AC-033-14** — *Given* включённое задание с двумя запусками в очереди *When* `disable('user')` *Then* `disabledReason: 'user'`, `nextRunAt: null`, запуски `cancelled`, `event = null`.
- **AC-033-15** — *Given* задание с триггером-фикстурой, фейк `invokeNode` отдаёт `{ events: [e1, e2], cursor: 'c2' }` *When* `tick` *Then* `poll` с курсором задания, `stateKey = process:<id>:<t>`, `timeoutMs = pollTimeoutMs`; два запуска в порядке `e1`, `e2`; курсор `c2`; `nextRunAt = now + pollIntervalSec`; аренда снята.
- **AC-033-16** — *Given* фейк `invokeNode` отдаёт `{ ok: false, code: 'timeout' }`, затем бросает *When* два такта *Then* курсор прежний, запусков нет, `lastError.code` — `timeout`, затем `orchestrator_unavailable`, `consecutiveFailures: 2`; *When* счётчик дошёл до `pollMaxFailures` *Then* `enabled: false`, `disabledReason: 'poll_failed'`, очередь не тронута.
- **AC-033-17** — *Given* в очереди задания `queueMax` запусков *When* `tick` *Then* `poll` не вызывается, курсор прежний; `createRun` — `queue_full`.
- **AC-033-18** — *Given* `swag/schedule` `everySec: 60`, `nextRunAt = 10:00:00`, часы `10:00:03` *When* `tick` *Then* один запуск с событием `{ scheduledAt: '…10:00:00…', firedAt: '…10:00:03…' }`, `nextRunAt = 10:01:03`, `invokeNode` не вызывается. *Given* `nextRunAt` на час в прошлом *Then* один запуск.
- **AC-033-19** — *Given* задание с `maxConcurrent: 1` и три запуска в очереди, фейк `api.launchRun` отдаёт `launched` *When* `tick` *Then* `launchRun` вызван один раз с `{ runId, processId, event }` первого запуска; он `running` с `launchedAt`, два — `queued`. *When* `runStatuses` отдаёт `completed` и следующий `tick` *Then* первый `completed` с `finishedAt`, запущен второй.
- **AC-033-20** — *Given* `launchRun` отдаёт `rejected insufficient_balance`; `rejected invalid_graph`; `process_not_found`; `busy`; бросает *When* `tick` *Then* `rejected` с причиной (`event = null`); `rejected`; `cancelled`; запуск и оставшиеся взятые — снова `queued`; то же при исключении. Задание остаётся включённым.
- **AC-033-21** — *Given* запуски в `launching`: исполнение есть (`running`), есть (`completed`), нет (`null`) *When* `recover` *Then* `running`; `completed` с `finishedAt`; `queued`.
- **AC-033-22** — *Given* две реплики ядра планировщика на одном `JobStore` Postgres (стек-тест) и одно задание с одним запуском *When* такты обеих одновременно *Then* `poll` вызван один раз, `launchRun` — один раз.
- **AC-033-23** — *Given* фейк `RootSpans` *When* `tick` с опросом и запуском *Then* `run('process.poll', { 'swag.process': id })` вокруг `invokeNode`, `run('process.run', …)` вокруг `launchRun`.
- **AC-033-24** — *Given* событие с маркером `event-marker-033`, курсор `cursor-marker-033`, настройки триггера `settings-marker-033` *When* опрос и запуск на фейках *Then* маркеров нет в логах `scheduler-core` и `api-core`; после `running` маркера события нет в `RunRecord`; `ProcessRunView`, `JobState`, `ProcessView.job` не содержат события и курсора.
- **AC-033-25** — *Given* фейки `ProcessStore` и `SchedulerClient`, актор `user` *When* `POST /processes` с графом AC-033-2 и `everySec: 60` *Then* `201`; `putJob` вызван до `processes.create` с `JobSpec` (`trigger.nodeId: 't'`, настройки с умолчаниями); `ProcessView.trigger { nodeId: 't', type: 'swag/schedule@1.0.0' }`, `job.enabled: false`. При `PROCESS_MAX_PER_ORG` процессах — `409 too_many_processes`; `putJob` бросает — `503 scheduler_unavailable`, определения нет.
- **AC-033-26** — *Given* расписание с `everySec` и `cron` вместе; без обоих; `cron: 'bad'`; `timezone: 'Mars/Base'`; бюджет агента больше бюджета запуска *When* `POST /processes` *Then* `400 invalid_graph` с `invalid_settings` по путям 4.5; бюджет — `400 validation_error`; `putJob` не вызван.
- **AC-033-27** — *Given* процесс без триггера *When* `enable` *Then* `409 process_no_trigger`. *Given* процесс со сторонним триггером и удалённым после сохранения секретом *When* `enable` *Then* `400 invalid_graph` с `secret_not_found`, `scheduler.enable` не вызван.
- **AC-033-28** — *Given* процесс `B` с `swag/process` на `A` *When* `DELETE /processes/A` *Then* `409 process_in_use`; после удаления `B` — `204`, `deleteJob` вызван до `processes.delete`.
- **AC-033-29** — *Given* пользователи `u1`, `u2` одной организации, `admin`, `supervisor`, пользователь другой организации *When* `GET /processes`, `GET /processes/:id`, `PUT`, `POST …/runs`, `GET …/runs` по процессу `u1` *Then* `u1` и `admin` видят и меняют; `u2` и чужая организация — `404`; `supervisor` видит, `PUT` и `POST …/runs` — `403`.
- **AC-033-30** — *Given* процесс с триггером-фикстурой *When* `POST /processes/:id/runs` с событием не по `outputs` *Then* `400 invalid_event`, `createRun` не вызван; по `outputs` — `202` с `ProcessRunView` от планировщика; `queue_full` — `409`.
- **AC-033-31** — *Given* у автора два процесса *When* обработчик блокировки *Then* `scheduler.disable(id, 'author_blocked')` по каждому, после `stopSwarmsOfUser`; процессы другого пользователя не тронуты.
- **AC-033-32** — *Given* процесс `t → x (echo) → a` *When* `POST /internal/process-runs` с `runId` и событием *Then* `launched`; исполнение с id `runId`, `swarm.created.data.processId`, `createdBy` — автор процесса, резерв на `budgetMicroUsd` определения; `SwarmLaunch.trigger.nodeId = 't'`, программа `x` со `stateKey process:<id>:x`. Повтор с тем же `runId` — `launched` без второго `launch`. Нехватка баланса — `rejected insufficient_balance`; удалённый секрет — `rejected invalid_graph`; лимит активных — `busy`; нет процесса — `process_not_found`. `POST /internal/process-runs/status` — статусы и `null`.
- **AC-033-33** — *Given* `POST /swarms` с графом `e (echo) → p (swag/process → C)` *When* запуск *Then* `SwarmLaunch.programs` — `e` со `stateKey swarm:<id>:e`, `p-x`, `p-y` со `stateKey process:<C>:x`, `process:<C>:y`; `trigger: null`. `C` из другой организации — `400 invalid_graph` с `process_not_found`.
- **AC-033-34** — *Given* маршруты планировщика и `/internal/*` `api` *When* без токена, с чужим токеном, с токеном пользователя `api` *Then* `401`; с верным токеном — по таблицам 4.9 и 4.10. Публичные маршруты `api` с `API_INTERNAL_TOKEN` вместо токена пользователя — `401`.
- **AC-033-35** — *Given* оболочка `apps/scheduler` на фейковых таймерах, `tick` первого вызова висит, второго бросает *When* проходит `3 × PROCESS_TICK_MS` *Then* второй вызов начинается только после окончания первого; исключение — лог `process_tick_failed` с `errorName`, затем назначен следующий такт; `recover` вызван до первого `tick`.
- **AC-033-36** — *Given* `PROCESS_LEASE_MS = 30000`, `PROCESS_POLL_TIMEOUT_MS = 30000` *When* разбор `SchedulerConfig` *Then* ошибка конфига; умолчания по 4.14; `ApiConfig` — новые поля 4.14.
- **AC-033-37** `[manual]` — *Given* стек `npm run up` с сервисом `scheduler`, вход пользователем кабинета, баланс пополнен *When* `POST /processes` с графом `t (swag/schedule, everySec: 60) → echo (prefix «> ») → agent-1`, `entry = t`, `exit = agent-1`, затем `enable` *Then* за 3 минуты — 2–3 запуска в `GET /processes/:id/runs`, каждый доходит до `completed`; у исполнения запуска первое сообщение агенту — от `echo`, текст начинается с «> »; в Grafana трейс исполнения начинается спаном `process.run` сервиса `scheduler`. *When* `disable` *Then* новых запусков нет 2 минуты. Проверка: curl с токеном, страница исполнения в кабинете и Grafana; результат в журнал.
- **AC-033-38** `[manual]` — *Given* тот же стек *When* `POST /processes/:id/runs` у выключенного процесса без триггера (`echo → agent-1`) с событием `{ "text": "назови одно море" }` *Then* за ≤ `PROCESS_TICK_MS` + 2 с запуск `running`, затем `completed`; перезапуск контейнера `scheduler` во время исполнения не даёт второго исполнения. Проверка: curl и `docker compose restart scheduler`; результат в журнал.

## 6. Нефункциональные требования

| ID | Требование | Как измеряется |
|---|---|---|
| NFR-033-1 | Срабатывание расписания ставит запуск не позже `nextRunAt + PROCESS_TICK_MS + 1 с` при ≤ 20 включённых заданиях | тест ядра на фейковых часах; на стеке — по `createdAt` запусков AC-033-37, результат в журнал |
| NFR-033-2 | `expandGraph` + `checkGraph` графа с тремя уровнями вложенности и 16 узлами после разворачивания — p95 < 10 мс | тест-замер на 1000 прогонах в `api-integration`, результат в журнал |

## 7. Безопасность: что не должно сломаться

- Процесс одной организации не видит и не запускает процессы и секреты другой: дочерний процесс ищется в организации родителя, `credentials` триггера — по секретам организации процесса, `orgId` опроса — организация процесса → AC-033-29, AC-033-33, AC-033-27.
- Внутренние API доступны только своим сервисам: `SCHEDULER_TOKEN` и `API_INTERNAL_TOKEN`, токен пользователя на них не работает, внутренний токен не открывает публичные маршруты → AC-033-34.
- Запуск не обходит деньги: резерв бюджета запуска с баланса организации, отказ при нехватке, бюджет агента ≤ бюджета запуска → AC-033-32, AC-033-26.
- Процесс не захватывает ресурсы бесконтрольно: очередь ≤ `PROCESS_QUEUE_MAX`, `maxConcurrent`, `MAX_ACTIVE_SWARMS`, выключение после ошибок опроса, лимит процессов на организацию → AC-033-17, AC-033-16, AC-033-19, AC-033-25.
- Заблокированный пользователь не продолжает тратить деньги организации через процессы → AC-033-31.
- Событие триггера (данные внешней системы, возможно персональные) живёт только в очереди и не попадает в логи и публичные ответы → AC-033-24.
- Запуск не исполняется дважды: аренда задания, `launching`, идемпотентный `launchRun` по `runId`, восстановление после перезапуска → AC-033-22, AC-033-32, AC-033-21, AC-033-38.
- `POST /swarms` ведёт себя как до 033 → AC-033-7, тесты 009.

## 8. Задачи для агента

Выполняются по порядку. После каждой задачи — коммит. Каждая задача — свой этап `spec/033-tN` в `main`: необязательные поля `SwarmLaunch` (4.2) не ломают `api` и оркестратор между этапами.

- [x] **T-1.** Контракты: `packages/contracts/src/process.ts` по 4.1 и экспорт; права в `access.ts`; коды `GraphIssueCode` (4.3); `LaunchProgram.stateKey`, `LaunchTrigger`, `SwarmLaunch.trigger` (4.2); `processId` в `swarm.created`. Тесты схем в `packages/contracts/test`. Закрывает: AC-033-1, REQ-033-22 (права). Готово, когда: тесты и `npm run typecheck` зелёные, прежние тесты пакета без правки ожиданий.
- [x] **T-2.** Пакет `packages/node-schedule` по 4.5 (`package.json`, `tsconfig.json` по образцу `@swag/node-llm-agent`, `src/node.ts`, `swag-node.json` через `npm run nodes:manifest`, README, тест загрузки `loadNodePackages`); `SCHEDULE_TRIGGER_TYPE` в `api-integration`. Закрывает: REQ-033-9 (тип узла). Готово, когда: тест зелёный.
- [x] **T-3.** Пакет `packages/node-process` по 4.4 — так же, как T-2; подключение обоих пакетов: зависимости `apps/api`, `NODE_PACKAGES` в `compose.yaml`, `.env.example`, `.env`. Закрывает: REQ-033-17 (тип узла). Готово, когда: тест зелёный, `GET /node-types` на стеке отдаёт пять типов.
- [x] **T-4.** `checkGraph` с `triggers` и `launchGraph` в `packages/api-integration/src/process-graph.ts` (4.3). Закрывает: REQ-033-3, AC-033-2, AC-033-3, AC-033-4. Готово, когда: тесты AC и прежние тесты 009 зелёные без правки ожиданий.
- [x] **T-5.** `expandGraph`, `PROCESS_NODE_TYPE`, `PROCESS_NEST_MAX_DEPTH`, `NodeOrigin` (4.4). Закрывает: REQ-033-17, AC-033-5, AC-033-6, NFR-033-2. Готово, когда: тесты AC зелёные, замер в журнале.
- [x] **T-6.** `SwarmView.processId` в `packages/api-integration/src/swarm-view.ts`. Закрывает: AC-033-9. Готово, когда: тест и прежние тесты проекции зелёные.
- [x] **T-7.** `orchestrator-core`: `stateKey` из `LaunchProgram` с умолчанием `swarm:<swarmId>:<nodeId>`; вход шага-входа от `launch.trigger` в `checkReady` и `AGENT_TASK_FROM` в `agentSpec`. Закрывает: REQ-033-15, REQ-033-27, AC-033-7, AC-033-8. Готово, когда: тесты AC и прежние тесты оркестратора зелёные.
- [x] **T-8.** Пакет `packages/adapter-croner` с `createCronerSchedule` на `croner@9.1.0`, README. Закрывает: AC-033-10. Готово, когда: тест AC и `npm run arch:check` зелёные.
- [x] **T-9.** Каркас `packages/scheduler-core` по 4.7: типы и порты, `PROCESS_TICK_BATCH`, `createSchedulerCore` с пустыми операциями, README; ядро — в правилах `arch:check` по образцу `orchestrator-core`. Закрывает: — (основа T-14…T-16). Готово, когда: `npm run typecheck` и `npm run arch:check` зелёные.
- [x] **T-10.** `adapter-memory`: `createMemoryJobStore` и `createMemoryProcessStore`; общий набор тестов `packages/adapter-memory/test/job-store.cases.ts` и `process-store.cases.ts`. Порт `ProcessStore` и `ProcessRecord` в `api-core` (4.6, только типы). Закрывает: AC-033-11 (память). Готово, когда: наборы зелёные.
- [ ] **T-11.** `adapter-postgres`: миграция `0007_processes.sql` (4.8), `createPostgresJobStore`, `createPostgresProcessStore`; те же наборы на тестовой БД (стек-тест), `skip locked` двумя соединениями. Закрывает: AC-033-11. Готово, когда: наборы зелёные на Postgres.
- [ ] **T-12.** `invokeNode` в `packages/adapter-orchestrator-http` и `createRootSpans` в `packages/adapter-telemetry` (4.10). Закрывает: REQ-033-7 (транспорт), REQ-033-25 (адаптер). Готово, когда: тесты адаптеров (путь, токен, `traceparent`, таймаут, исключение на не-2xx; спан без родителя) зелёные.
- [ ] **T-13.** Пакеты `packages/adapter-scheduler-http` (`createSchedulerHttpClient`, 4.9) и `packages/adapter-api-http` (`createApiInternalHttpClient`, 4.10) с README и тестами на фейковом HTTP-сервере (пути, токен, `traceparent`, разбор ответов и кодов `404`/`409` в результаты `SchedulerClient`). Порт `SchedulerClient` — в `api-core` (только тип). Закрывает: REQ-033-23 (клиенты). Готово, когда: тесты зелёные.
- [ ] **T-14.** `scheduler-core`: `putJob`, `enable`, `disable`, `deleteJob`, `states`, `createRun`, `runs`, `nextScheduleRun` (4.5, 4.7). Закрывает: REQ-033-4 (планировщик), REQ-033-5 (планировщик), AC-033-12, AC-033-13, AC-033-14. Готово, когда: тесты AC зелёные.
- [ ] **T-15.** `scheduler-core`: `tick`, шаги 1–2 (4.13). Закрывает: REQ-033-6, REQ-033-7, REQ-033-8, REQ-033-9, REQ-033-10, AC-033-15…AC-033-18, NFR-033-1 (ядро). Готово, когда: тесты AC зелёные.
- [ ] **T-16.** `scheduler-core`: `tick`, шаги 3–4, и `recover` (4.13); спаны и маркеры. Закрывает: REQ-033-11, REQ-033-13 (планировщик), REQ-033-14, REQ-033-21, REQ-033-24, REQ-033-25, AC-033-19, AC-033-20, AC-033-21, AC-033-23, AC-033-24 (планировщик). Готово, когда: тесты AC зелёные.
- [ ] **T-17.** Оболочка `apps/scheduler` (по образцу `apps/orchestrator`): `SchedulerConfig` в `packages/config` с проверкой аренды, маршруты 4.9, цепочка такта и `recover`, сборка адаптеров, Dockerfile, сервис в `compose.yaml`, `.env.example`, `.env`, README; стек-тест AC-033-22. Закрывает: AC-033-22, AC-033-34 (планировщик), AC-033-35, AC-033-36 (планировщик). Готово, когда: тесты `apps/scheduler` зелёные, `npm run up` поднимает `scheduler` здоровым.
- [ ] **T-18.** `api-core`: `startSwarm` по 4.12 — `createSwarm` через него, `expandGraph` в `POST /swarms`, `stateKey` программ, `trigger: null`, `processId: null`. Закрывает: REQ-033-18, REQ-033-27, AC-033-33. Готово, когда: тест AC и прежние тесты `api-core` и `apps/api` зелёные без правки ожиданий (кроме `stateKey` в ожидаемом `SwarmLaunch`).
- [ ] **T-19.** `api-core`: `checkProcessDraft`, `jobSpec`, `createProcess`, `getProcess`, `listProcesses`, `updateProcess`, `deleteProcess` с видимостью (4.11); `CronSchedule` в `ApiCoreDeps`. Закрывает: REQ-033-1, REQ-033-2, REQ-033-4, REQ-033-19, REQ-033-22, REQ-033-26, AC-033-25, AC-033-26, AC-033-28, AC-033-29 (CRUD). Готово, когда: тесты AC зелёные.
- [ ] **T-20.** `api-core`: `enableProcess`, `disableProcess`, `runProcess`, `listProcessRuns`, `disableProcessesOfUser`, `launchRun`, `runStatuses` (4.10, 4.11). Закрывает: REQ-033-5, REQ-033-12, REQ-033-13, REQ-033-16, REQ-033-20, AC-033-27, AC-033-29 (запуски), AC-033-30, AC-033-31, AC-033-32, AC-033-24 (`api`). Готово, когда: тесты AC зелёные.
- [ ] **T-21.** Оболочка `apps/api`: маршруты 4.10 и 4.11, коды `STATUS`, токен `/internal/*`, поля `ApiConfig` (4.14), сборка `createPostgresProcessStore`, `createSchedulerHttpClient`, `createCronerSchedule`; `disableProcessesOfUser` в `createBlockHandler`; HTTP-тесты. Закрывает: REQ-033-23, AC-033-34 (`api`), AC-033-36 (`api`). Готово, когда: тесты `apps/api` и `npm run check` зелёные.
- [ ] **T-22.** Глоссарий (сверка), README затронутых пакетов (`contracts`, `api-integration`, `api-core`, `orchestrator-core`, `scheduler-core`, `adapter-memory`, `adapter-postgres`, `adapter-orchestrator-http`, `adapter-telemetry`, `adapter-croner`, `adapter-scheduler-http`, `adapter-api-http`, `node-schedule`, `node-process`, `config`, `apps/api`, `apps/scheduler`); корневой README (сервис, маршруты, переменные); раздел «Процессы и планировщик» в `docs/architecture.md` и схема `architecture.mmd`/`.svg`; ручные AC-033-37, AC-033-38 и замер NFR-033-1 на стеке в журнал. Закрывает: AC-033-37, AC-033-38, NFR-033-1. Готово, когда: README сверены с кодом, проверки в журнале.

## 9. Открытые вопросы

Пока список не пуст, спека не может быть `ready`.

- [x] **Q-1. Где живёт планировщик.** Варианты: (а) в `api`; (б) отдельный сервис. Рекомендация была (а). *(Claude, 2026-11-03)*
  **Ответ (человек, 2026-11-03):** планировщик — отдельный сервис; хранит все задания и статусы в БД и умеет их запускать. Принято: `apps/scheduler` + `scheduler-core`, таблицы `scheduler_jobs` и `process_runs`, запуск через внутренний маршрут `api` (4.7–4.10, 4.13).
- [x] **Q-2. Запуск процесса и рой.** Черновик делал запуск роем с тем же id. *(Claude, 2026-11-03)*
  **Ответ (человек, 2026-11-03):** рой — только в контексте агентов: умные агенты, связанные между собой, — это рой; всё остальное — процесс; узел процесса может быть роем (командой агентов). Принято: запуск процесса — своя сущность `ProcessRun` со статусами в планировщике; исполнение запуска пока идёт механизмом, который в коде называется `Swarm` (раздел 1, «Термины»), переименование — Q-10.
- [x] **Q-3. Права и видимость процессов.** **Ответ (человек, 2026-11-03):** по рекомендации — `process.read`, `process.manage`, видимость как у роёв.
- [x] **Q-4. Чьи права у запуска.** **Ответ (человек, 2026-11-03):** по рекомендации — от автора процесса, блокировка автора выключает его процессы.
- [x] **Q-5. Библиотека cron.** **Ответ (человек, 2026-11-03):** по рекомендации — `croner@9.1.0` за портом `CronSchedule`, 5 полей, часовой пояс по умолчанию `UTC`.
- [x] **Q-6. Вложенный процесс.** **Ответ (человек, 2026-11-03):** по рекомендации — разворачивание в граф родителя, общий бюджет и таймаут, глубина 3.
- [x] **Q-7. Нехватка баланса.** **Ответ (человек, 2026-11-03):** по рекомендации — `rejected insufficient_balance`, без повтора, процесс включён.
- [x] **Q-8. Числа.** **Ответ (человек, 2026-11-03):** по рекомендации — опрос 300 с (≥ 60), расписание ≥ 60 с, такт 5 с, очередь 20, `maxConcurrent` 1 (≤ 4), 10 ошибок, 50 процессов, аренда 120 с, таймаут опроса 30 с.
- [x] **Q-9. Ручной запуск.** **Ответ (человек, 2026-11-03):** по рекомендации — есть (`POST /processes/:id/runs`).
- [x] **Q-10. Переименование «роя» в коде и API** *(из ответа на Q-2)*. По новым терминам рой — команда агентов, а то, что сейчас в коде называется `Swarm` (`POST /swarms`, `GET /swarms/:id`, события `swarm.*`, `SwarmLaunch`, `SwarmView`, `swarmId`, таблицы `swarms`, страница «рой» в кабинете, `MAX_ACTIVE_SWARMS`), — это исполнение графа процесса. Тексты роадмапа («Рой — это граф процесса») и 009 тоже расходятся с новыми терминами. Варианты: **(а)** 033 вводит новые термины только для процесса и запуска, код исполнения остаётся `Swarm`; переименование — отдельной спекой сразу после 033 (маршруты, события с совместимостью чтения старых событий из Postgres, UI, роадмап, глоссарий); **(б)** переименовать в рамках 033 — спека вырастет примерно на 10 задач во всех пакетах, затронет маршруты и события; **(в)** не переименовывать, закрепить в глоссарии, что `Swarm` в коде — исполнение. Рекомендация — **(а)**: 033 и так большая, переименование меняет публичный API и формат событий, его лучше принять отдельно. *(Claude, 2026-11-03)*
  **Ответ (человек, 2026-11-03):** перейти на термины «процесс» и «узел процесса»; узлом процесса может быть другой процесс; внутри процесса могут быть агенты — умные узлы с агентным циклом. Уточнение (человек, 2026-11-03): большого рефакторинга не делать, рой = процесс. Принято по варианту (в): «рой» — синоним процесса в исполнении; `Swarm` в коде, API, событиях и UI остаётся, глоссарий закрепляет соответствие (раздел 1).

## 10. Журнал реализации

Заполняет агент.

| Дата | Ветка / коммит | Что сделано | Отклонения от спеки |
|---|---|---|---|
| 2026-11-03 | spec/033-t1 | T-1: контракты процесса, задания и запуска; права; коды графа; `stateKey`, `LaunchTrigger`, `SwarmLaunch.trigger`; `processId` в `swarm.created`. | `BudgetMicroUsd`, `MaxTokens` импортируются из `llm.ts`, `OrgId` — из `auth.ts` (в `swarm.ts` их нет). Выходной тип `SwarmLaunch` после `.default(null)` требует `trigger`, поэтому уже в T-1 `api-core` передаёт `trigger: null`, а ожидания `SwarmLaunch` в тестах `api-core` и `adapter-orchestrator-http` получили `trigger: null`. Таблица прав в `access.test.ts` дополнена новыми правами. |
| 2026-11-03 | spec/033-t2 | T-2: `packages/node-schedule` (`swag/schedule@1.0.0`, вид `trigger`), `swag-node.json`, тест REQ-033-9; `SCHEDULE_TRIGGER_TYPE` в `api-integration`; корневой `tsconfig.json`; глоссарий: `@swag/node-schedule` в «Пакет узла». | Тест загрузки передаёт `resolve` на файл пакета (не требует ссылки воркспейса до `npm install` в T-3). Тесты помечены `REQ-033-9`: AC для типа узла в разделе 5 нет. |
| 2026-11-03 | spec/033-t2 | T-3 (в одном этапе с T-2 — однотипные пакеты узлов): `packages/node-process` (`swag/process@1.0.0`, вид `program`), `swag-node.json`, тест REQ-033-17; `@swag/node-schedule` и `@swag/node-process` в `devDependencies` `apps/api`; `NODE_PACKAGES` по умолчанию в `compose.yaml` (`api`, `orchestrator`), `.env.example` и `.env`; корневой `tsconfig.json`; `npm install` (в `package-lock.json` только новые воркспейсы); глоссарий и `docs/architecture.md` — новые пакеты. | Пакеты в `devDependencies` `apps/api`, как `@swag/node-example`. `GET /node-types` на стеке не проверялся — оставлено на ручную приёмку T-22; типов после T-3 четыре (`example/echo`, `swag/llm-agent`, `swag/schedule`, `swag/process`), «пять» в критерии готовности T-3 — описка. Ожидание `NODE_PACKAGES` из `.env.example` в тесте AC-021-24 (`packages/config`) дополнено новыми пакетами по 4.14. |
| 2026-11-03 | spec/033-t4 | T-4: `checkGraph` с опцией `triggers` (проходы 1, 2, 4, 5 для вида `trigger`), `launchGraph` (экспорт из `api-integration`); тесты AC-033-2, AC-033-3, AC-033-4 в `test/process-graph-033.test.ts`. | Трактовки, которых нет в 4.3: входящее `flow` в триггер — `trigger_flow` по `edges.<j>` (иначе после `launchGraph` висячее ребро); триггер не получает `unreachable`, его отсутствие в цепочке — `trigger_not_entry`; `entry_has_input` и `flow_fan_in` к триггеру не применяются. |
| 2026-11-03 | spec/033-t4 | T-6: `SwarmView.processId` из `swarm.created.data.processId` (без поля — `null`); тест AC-033-9 в `test/swarm-view.test.ts`; в `ui-core/test/money-format.test.ts` литерал `SwarmView` дополнен `processId: null`. | Нет. |
| 2026-11-03 | spec/033-t5 | fix: замечания ревью T-5. `splitTrigger` (общая точка удаления триггера для `launchGraph` и `expandLevel`): битый триггер дочернего графа — `process_invalid`, не исключение; пути `process_cycle`, `process_too_deep`, `process_node_id_too_long` поднимаются к узлу корня, место — в `message`; тесты AC-033-5 (два процесса-узла, `e → p → f`, entry = exit, `link` → `flow`) и AC-033-6 (цикл при rootId и null, битый триггер); замечание N-37 в notes. Зелёные: тесты `api-integration` (80), `typecheck`, `lint`, `prettier`. | Трактовки — D-184 (обновлён). |
| 2026-11-03 | spec/033-t5 | T-5: `expandGraph(graph, children, rootId, registry)`, `PROCESS_NODE_TYPE`, `PROCESS_NEST_MAX_DEPTH`, `NodeOrigin`, `ExpandResult` в `process-graph.ts` (4.4, все шаги, триггер дочернего графа убирается через `launchGraph`); экспорт; тесты `test/expand-graph.test.ts`: AC-033-5 (`t → x → y`, триггер убран), AC-033-6 (пять замечаний и валидная цепочка глубины 3), NFR-033-2: p50 0,033 мс, p95 0,070–0,076 мс (1000 прогонов, два прогона). Зелёные: тесты `api-integration` (72), `typecheck`, `lint`, `arch:check`, `prettier`. | `expandGraph` получает `registry` — без него вид `trigger` не определить (D-184). Трактовки (D-184): (1) глубина: корень — уровень 1, процесс-узел на уровне L разрешён при L ≤ 2; корень→A→B с обычным B разворачивается, корень→A→B→C — `process_too_deep`; (2) `process_cycle`, `process_too_deep`, `process_node_id_too_long` поднимаются без обёртки, остальные замечания дочернего графа — `process_invalid` с текстом `<code> at <path>` первого замечания; путь `process_too_deep` и `process_node_id_too_long` — относительно графа, где узел (для глубокой цепочки — граф уровня 3); (3) путь `process_node_id_too_long` — `nodes.<j>.id`, `j` — индекс узла в его графе; (4) ребро с процессом-узлом переносится по правилу `flow` (от — выход, к — вход), вид ребра не меняется; (5) рёбра дочернего графа добавляются в конец массива рёбер. Триггер убирается только у дочерних графов; триггер корня убирает вызывающий через `launchGraph`. `launchGraph` бросает на граф с замечаниями `checkGraph`, поэтому дочерний граф должен проходить проверку при создании процесса. |

| 2026-11-03 | spec/033-t7 | T-7: `OrchestratorCore`: `stateKey` программы — из `LaunchProgram.stateKey`, иначе `swarm:<swarmId>:<nodeId>`; вход шага-входа от `launch.trigger` в `checkReady` (программа — `execute` с `trigger.event`, команда — сообщение от `trigger.nodeId` с `valueText(event)`), `AGENT_TASK_FROM = trigger.nodeId` в `agentSpec`; тесты AC-033-7, AC-033-8 в `test/orchestrator-core.test.ts`. Оболочка `apps/orchestrator` не менялась: `launch` передаёт тело в `SwarmLaunch.safeParse`, новые поля приходят сами. Зелёные: `orchestrator-core` и `apps/orchestrator` (96 тестов), `tsc -b --force`, `typecheck`, `lint`, `arch:check`, `prettier`. | Трактовка: программный тест AC-033-8 берёт событие `{ text: 'x' }`, а не `{ n: 1 }`: вход эхо-программы по манифесту `{ text: string }`, и `{ n: 1 }` дал бы `invalid_input` до ядра. Ядро передаёт вход без изменений, это и проверено. |
| 2026-11-03 | spec/033-t8 | T-8: `packages/adapter-croner` (`createCronerSchedule`, `croner` 9.1.0 точно), тест AC-033-10, README; корневой `tsconfig.json`. | Интерфейс `CronSchedule` повторён в адаптере структурно: адаптер не зависит от ядра (T-9 объявит тот же порт в `scheduler-core`). Число полей (5) проверяет адаптер до разбора, потому что croner принимает и шесть. |
| 2026-11-03 | spec/033-t8 | T-9: `packages/scheduler-core` — каркас: типы и порты 4.7, `CronSchedule`, `PROCESS_TICK_BATCH = 20`, `createSchedulerCore` с заглушками `not implemented`; README; `tsconfig.json` (корень); глоссарий: `@swag/adapter-croner` в строке «Триггер-расписание». | Зависимости ядра — только `@swag/contracts`: `zod` и `@swag/api-integration` не нужны каркасу, подключатся в T-14 (`nextScheduleRun`). `Logger` в ядре с `processId` в `LogContext` вместо `swarmId`/`agentId`. |
| 2026-11-03 | spec/033-t10 | T-10: `createMemoryJobStore` и `createMemoryProcessStore` в `adapter-memory` (4.6, 4.7, 4.8 по семантике памяти); общие наборы `test/job-store.cases.ts` (`jobStoreCases`) и `test/process-store.cases.ts` (`processStoreCases`) с тестами `AC-033-11` на память (16 тестов заданий и запусков и 6 тестов процессов, 22 в сумме); порт `ProcessStore` и тип `ProcessRecord` в `api-core` (4.6, только типы); зависимость `@swag/scheduler-core` в `adapter-memory`; глоссарий; README `adapter-memory`, `api-core`. | Копии записей — через `JSON`, а не `structuredClone`: в `lib: ES2023` без DOM и `types: []` `structuredClone` не объявлен. `recordTick` с занятым id запуска и `enqueue` без задания бросают исключение, как нарушение FK и первичного ключа в Postgres. `ProcessStore.update` неизвестного id бросает (трактовка по образцу `updateUser`). `put` аренду не трогает (аренда не часть `JobRecord`). `setRun` для неизвестного id — no-op. Наборы не требуют пустой базы: проверки по своим id, лимит — по длине выборки там, где своих записей хватает на лимит. |
