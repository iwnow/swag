---
id: "009"
title: Граф процесса
status: in-progress
roadmap_stage: 9
depends_on: ["021", "022", "026"]
superseded_by: null
updated: 2026-11-03
---

# 009. Граф процесса

> **Коротко.**
> - Рой становится графом процесса `ProcessGraph`. Узлы графа — экземпляры типов из реестра (`type@version`, настройки, credentials). Рёбра двух видов: «поток» (`flow`, выход одного узла — вход другого) и «связь» (`link`, агенты переписываются через шину).
> - `POST /swarms` принимает либо прежнюю форму роя, либо граф. Форму `api` превращает в граф: агенты — узлы `swag/llm-agent`, связи «все со всеми», вход и выход — `agent-1`. Существующий UI работает без изменений.
> - Граф проверяет `api` (D-157 «б»): типы и настройки узлов по реестру, имена credentials и наличие секретов организации, рёбра, циклы потоков, достижимость, лимиты. Ту же проверку без запуска даёт `POST /graph-checks`, она нужна редактору (017) и координатору (027). Оркестратор получает граф уже проверенным.
> - Исполнение смешанного графа. Агенты, связанные рёбрами `link`, образуют команду: это рой как узел графа. У команды один агент-вход: он получает вход потока и вызывает `finish`, его результат уходит дальше по потоку. Программа (`program`) вызывается в песочнице по 026, когда к ней пришёл вход. Циклы потоков запрещены, циклы связей разрешены. Рой завершается, когда завершились все начатые шаги; итог роя — выход узла-выхода.
> - У программ появляются события `node.started`, `node.completed`, `node.failed`, их список и строки в ленте на странице роя. Падение программы приводит к `swarm.failed` с причиной `node_failed`.
> - **Объём сужен (Q-1, ответ «а»):** триггеры, сохранённые процессы, запуск процесса без пользователя и вложенный процесс-узел — спека 033. Бот как процесс — 018 (D-28 → Q-4).
> - **Что нужно от человека:** ответить на Q-2…Q-10. Главные — Q-2 (правила исполнения, D-22) и Q-3 (рой как узел, D-77).

## 1. Контекст и цель

Роадмап, [раздел 4 «Граф процесса»](../../AI_PLATFORM_ROADMAP.md#4-граф-процесса) и этап 9: процесс — граф из узлов с рёбрами «поток» и «связь», оркестратор проверяет граф до запуска песочниц, рой — один из видов процесса и сам может быть узлом.

Сейчас рой — список агентов из формы (`SwarmCreateRequest`, до 8 агентов). Все агенты пишут всем, задачу получает `agent-1`, его `finish` завершает рой. Узлы с кодом (021, 026) вызываются только напрямую через `POST /node-invocations`, графа нет.

После спеки рой описывается графом из узлов реестра: агенты и программы, связанные потоками и связями. `api` проверяет граф целиком, оркестратор исполняет его: передаёт выходы по потокам, вызывает программы, запускает команды агентов. Форма роя остаётся частным случаем графа.

## 2. Объём

**Входит:**
- контракт графа `ProcessGraph`: узлы, рёбра `flow` и `link`, вход, выход; лимиты размера;
- `NodeId` для узлов графа, `AgentId` расширяется до `NodeId`;
- форма роя превращается в граф (`formGraph`);
- проверка графа `checkGraph`: структура, типы и настройки по реестру, credentials и секреты организации, вход узла-входа; `POST /graph-checks`;
- `POST /swarms` с графом; `SwarmLaunch` с узлами, рёбрами, входом и выходом;
- план исполнения `graphPlan`: шаги (программы и команды агентов), агенты-входы команд, участники по рёбрам `link`;
- исполнение в `orchestrator-core`: передача значений по потокам, вызов программ (`invokeNode` из 026), вход и `finish` команды, завершение роя по графу, остановка песочниц завершённой команды;
- `stateKey` узла графа;
- промпт агента-входа команды: источник задачи и получатель итога;
- события `node.started`, `node.completed`, `node.failed`, причина `swarm.failed` `node_failed`, `graph` в `swarm.created`;
- `SwarmView.nodes`, строки событий узлов и список узлов на странице роя.

**Не входит** (агент это не делает, даже если кажется логичным):
- узлы `trigger` и `channel` в графе, запуск процесса по событию, расписание опроса `poll`, курсор триггера — спека 033 (и 018, 020);
- сохранённый процесс: определение отдельно от активаций, таблица процессов, CRUD, включение и выключение — спека 033 и 017;
- процесс как узел другого процесса (вложенность), деление бюджета и таймаута на вложенный — спека 033 (из D-77);
- память команды между активациями, диалог, сжатие контекста — 018 (из D-77);
- бот как процесс, канал и диалог — 018 (D-28);
- коннекторы (`connector`) в графе и их операции как инструменты агента — спека инструментов агента (018/019);
- узел «человек» (`human`) — 028;
- слияние потоков: несколько входящих рёбер `flow` у одного узла (Q-6);
- условия и ветвления по значению, преобразование выхода под вход (маппинг полей) — 017/027 или позже;
- статическая проверка совместимости схем `outputs` → `inputs` по JSON Schema: в 009 значение проверяется при передаче (4.6);
- редактор графа и показ рёбер `flow` на схеме роя — 017; построение графа координатором — 027;
- отмена вызова программы, который ещё идёт при завершении роя: его песочницу убирает таймаут 026 (4.6, шаг 7);
- плата за compute программ — 005 (D-126).

## 3. Требования

| ID | Требование | Приоритет |
|---|---|---|
| REQ-009-1 | `POST /swarms` MUST принимать `SwarmCreateRequest` (форма) или `SwarmGraphRequest` (граф). Форма MUST превращаться в граф `formGraph` (4.3) и дальше идти тем же путём, что граф. | MUST |
| REQ-009-2 | `api` MUST проверять граф `checkGraph` (4.4) до резерва бюджета и запуска. Граф с замечаниями MUST отклоняться `400 invalid_graph` со всеми замечаниями, без события `swarm.created` и без резерва. | MUST |
| REQ-009-3 | `checkGraph` MUST проверять: уникальность id узлов; тип узла есть в реестре; вид узла `llm-agent` или `program`; настройки по схеме `settings`; ключи `credentials` совпадают с манифестом; каждый секрет есть в организации; концы рёбер; рёбра `link` только между агентами; рёбра `flow` только между шагами, которые дают и принимают значение, и только к агенту-входу команды; не больше одного входящего `flow` у шага; отсутствие циклов `flow`; достижимость каждого шага от входа; вход и выход — шаги; лимиты 4.1. | MUST |
| REQ-009-4 | `checkGraph` MUST NOT останавливаться на первом замечании: результат содержит все найденные замечания в порядке 4.4. | MUST |
| REQ-009-5 | `POST /graph-checks` MUST отдавать `GraphCheckResult` для графа без запуска и без побочных эффектов. | MUST |
| REQ-009-6 | Вход роя с узлом-входом `program` MUST проверяться при `POST /swarms` по схеме `inputs` узла (`{ text: task }`); несовпадение — замечание `entry_input_invalid`. | MUST |
| REQ-009-7 | `SwarmLaunch` MUST нести `orgId`, агентов (настройки после проверки, с умолчаниями), программы, рёбра, вход и выход (4.5). Оркестратор MUST NOT проверять настройки узлов по реестру повторно (D-157 «б»). | MUST |
| REQ-009-8 | Оркестратор MUST строить план `graphPlan` (4.6): команда — компонента связности агентов по рёбрам `link`; у каждой команды ровно один агент-вход; участники агента — его соседи по `link`. | MUST |
| REQ-009-9 | После старта всех агентов оркестратор MUST передать задачу шагу-входу: команде — сообщение агенту-входу от `user`, программе — вызов `execute` со входом `{ text: task }`. | MUST |
| REQ-009-10 | Выход шага MUST передаваться по каждому исходящему ребру `flow`: программе — вызовом `execute` с выходом как входом, команде — сообщением шины агенту-входу от id шага-источника с текстом `valueText` (4.6). | MUST |
| REQ-009-11 | Выход команды MUST быть `{ text: result }` из `finish` её агента-входа. После выхода команды оркестратор MUST убрать песочницы её агентов. | MUST |
| REQ-009-12 | Вызов программы MUST идти через `invokeNode` 026 со `stateKey` по 4.7 и публиковать `node.started`, затем `node.completed` или `node.failed`. | MUST |
| REQ-009-13 | Ошибка вызова программы MUST завершать рой `swarm.failed` с причиной `node_failed` и `detail = "<nodeId>: <code>"`. | MUST |
| REQ-009-14 | Рой MUST завершаться `swarm.completed`, когда завершены все шаги, получившие вход, и узел-выход дал выход. Итог роя — `valueText` выхода узла-выхода. | MUST |
| REQ-009-15 | Только агенты-входы команд MUST получать `finish`. `finish` команды, которая не содержит узел-выход, MUST NOT завершать рой. | MUST |
| REQ-009-16 | Промпт агента-входа MUST называть источник задачи (пользователь или шаг процесса) и получателя итога (пользователь, если команда содержит выход, иначе следующий шаг процесса) по 4.8. Сообщение от шага-программы MUST подписываться как вход от шага процесса. | MUST |
| REQ-009-17 | Рой из формы MUST вести себя как до 009: те же события в том же порядке, задача `agent-1`, все агенты — участники друг друга, итог — `finish` `agent-1`. | MUST |
| REQ-009-18 | `swarm.created` MUST нести граф роя; `SwarmView` MUST показывать программы с их статусом (4.10). | MUST |
| REQ-009-19 | Страница роя SHOULD показывать список программ со статусом и строки событий `node.*` в ленте. | SHOULD |
| REQ-009-20 | Настройки и вход узлов MUST NOT попадать в события и логи; `node.failed` несёт только код и сообщение ошибки 026 с вымаранными секретами. | MUST |

## 4. Контракты

### 4.1. Граф: `packages/contracts/src/graph.ts`

```ts
import { z } from 'zod';
import { NodeTypeRef } from './node.ts';
import { SecretName } from './node-invocation.ts';

// Id узла графа. 'user' занят источником задачи в BusMessage.
export const NodeId = z
  .string()
  .regex(/^[a-z][a-z0-9-]{0,39}$/)
  .refine((id) => id !== 'user', 'node id "user" is reserved');
export type NodeId = z.infer<typeof NodeId>;

export const GRAPH_MAX_NODES = 16;
export const GRAPH_MAX_EDGES = 64;
export const GRAPH_MAX_AGENTS = 8; // как agents в SwarmCreateRequest и LlmSwarmRegistration

export const GraphNode = z.strictObject({
  id: NodeId,
  type: NodeTypeRef, // 'swag/llm-agent@1.0.0', 'example/echo@1.0.0'
  settings: z.record(z.string(), z.unknown()).default({}),
  credentials: z.record(z.string(), SecretName).default({}), // имя из credentials манифеста → секрет организации
});
export type GraphNode = z.infer<typeof GraphNode>;

export const EdgeKind = z.enum(['flow', 'link']);
export type EdgeKind = z.infer<typeof EdgeKind>;

// flow — выход from идёт входом в to. link — неориентированное: from и to пишут друг другу (Q-7).
export const GraphEdge = z.strictObject({ from: NodeId, to: NodeId, kind: EdgeKind });
export type GraphEdge = z.infer<typeof GraphEdge>;

export const ProcessGraph = z.strictObject({
  nodes: z.array(GraphNode).min(1).max(GRAPH_MAX_NODES),
  edges: z.array(GraphEdge).max(GRAPH_MAX_EDGES),
  entry: NodeId, // шаг, который получает задачу
  exit: NodeId, // шаг, чей выход — итог роя
});
export type ProcessGraph = z.infer<typeof ProcessGraph>;

export const GraphIssueCode = z.enum([
  'node_duplicate',
  'node_type_not_found',
  'node_kind_unsupported',
  'invalid_settings',
  'credentials_mismatch',
  'secret_not_found',
  'too_many_agents',
  'no_agents',
  'edge_unknown_node',
  'edge_self',
  'edge_duplicate',
  'link_requires_agents',
  'flow_requires_values',
  'flow_not_at_team_entry',
  'flow_fan_in',
  'flow_cycle',
  'entry_unknown',
  'entry_has_input',
  'exit_unknown',
  'exit_not_step',
  'unreachable',
  'entry_input_invalid',
]);
export type GraphIssueCode = z.infer<typeof GraphIssueCode>;

export const GraphIssue = z.strictObject({
  code: GraphIssueCode,
  path: z.string(), // путь в графе через точку: 'nodes.2.settings.role', 'edges.5', 'entry'; корень — ''
  message: z.string(),
});
export type GraphIssue = z.infer<typeof GraphIssue>;

export const GraphCheckResult = z.strictObject({
  ok: z.boolean(), // true ⇔ issues пуст
  issues: z.array(GraphIssue),
});
export type GraphCheckResult = z.infer<typeof GraphCheckResult>;
```

`index.ts` пакета экспортирует `graph.ts`.

**Термины 4.1–4.6.**
- **Агент графа** — узел вида `llm-agent`.
- **Программа** — узел вида `program`.
- **Команда** — компонента связности агентов графа по рёбрам `link`. Одиночный агент без рёбер `link` — команда из одного агента.
- **Шаг** — программа или команда. Рёбра `flow` соединяют шаги.
- **Агент-вход команды** — агент команды, который получает вход потока и вызывает `finish`. Если команда содержит `graph.entry`, это `graph.entry`. Иначе — агент, в который ведёт первое по массиву входящее ребро `flow` команды. Нет и его — первый агент команды в порядке узлов.
- **Шаг-вход** — шаг узла `graph.entry`. **Шаг-выход** — шаг узла `graph.exit`.

### 4.2. `AgentId`, `BusMessage`, форма с графом: `packages/contracts/src/swarm.ts`, `bus.ts`

```ts
// swarm.ts: было /^agent-[1-9][0-9]?$/. Id агента — id узла графа; форма по-прежнему даёт agent-1 … agent-8.
export const AgentId = NodeId;

// ENTRY_AGENT_ID остаётся: вход и выход роя из формы (4.3). Оркестратор его больше не использует (4.6).

export const SwarmGraphRequest = z.strictObject({
  task: z.string().trim().min(1).max(4000),
  budgetMicroUsd: BudgetMicroUsd,
  maxTokens: MaxTokens.nullable().default(null),
  graph: ProcessGraph,
});
export type SwarmGraphRequest = z.infer<typeof SwarmGraphRequest>;

// Тело POST /swarms. Форма отличается от графа полем agents, граф — полем graph (обе схемы strict).
export const SwarmRequest = z.union([SwarmCreateRequest, SwarmGraphRequest]);
export type SwarmRequest = z.infer<typeof SwarmRequest>;
```

`BusMessage.from` не меняется: `z.union([AgentId, z.literal('user')])`. После расширения `AgentId` источником может быть и программа графа (4.6).

### 4.3. Форма → граф: `formGraph` в `packages/api-integration/src/process-graph.ts`

```ts
export const LLM_AGENT_TYPE = 'swag/llm-agent@1.0.0';

export function formGraph(agents: readonly AgentDraft[]): ProcessGraph;
```

- узлы `agent-1 … agent-N` по порядку формы: `type: LLM_AGENT_TYPE`, `settings` — `AgentDraft` агента как есть, `credentials: {}`;
- рёбра `link` для каждой пары `i < j`: `{ from: 'agent-i', to: 'agent-j', kind: 'link' }`, в порядке `(1,2), (1,3) … (1,N), (2,3) …`;
- `entry` и `exit` — `agent-1` (`ENTRY_AGENT_ID`).

### 4.4. Проверка графа: `checkGraph` в `packages/api-integration/src/process-graph.ts`

```ts
export interface GraphCheckDeps {
  registry: NodeRegistry; // 021, 4.2; 026, 4.2
  secretNames: ReadonlySet<string>; // имена секретов организации (026, 4.6)
}

export function checkGraph(graph: ProcessGraph, deps: GraphCheckDeps): GraphCheckResult;
```

Вход — граф, уже разобранный `ProcessGraph`. Функция не бросает. Проходы идут по порядку, внутри прохода — по порядку узлов и рёбер в массивах. Замечание нужно для каждого нарушения. Узел с замечанием прохода 1 (дубль, неизвестный тип, неподдерживаемый вид) в проходах 2–5 не участвует. Ребро, которое касается такого узла или имеет замечание прохода 3, в проходах 4–5 не участвует.

1. **Узлы.**
   - id уже встречался — `node_duplicate`, путь `nodes.<i>.id`.
   - `registry.get(type)` = `null` — `node_type_not_found`, путь `nodes.<i>.type`.
   - вид не `llm-agent` и не `program` — `node_kind_unsupported`, путь `nodes.<i>.type`, сообщение `kind <kind> is not supported in a process graph yet`.
2. **Настройки и секреты** (узлы без замечаний прохода 1).
   - `registry.validateSettings(type, settings)` не `ok` — по замечанию `invalid_settings` на каждый `SettingsIssue`, путь `nodes.<i>.settings` + `.<issue.path>`, если путь не пуст.
   - множество ключей `credentials` не равно множеству `credentials[].name` манифеста — `credentials_mismatch`, путь `nodes.<i>.credentials`.
   - значение `credentials` не входит в `secretNames` — `secret_not_found`, путь `nodes.<i>.credentials.<name>`.
   - агентов графа больше `GRAPH_MAX_AGENTS` — `too_many_agents`, путь `nodes`; агентов нет — `no_agents`, путь `nodes`.
3. **Рёбра.**
   - конец не среди узлов — `edge_unknown_node`, путь `edges.<j>`.
   - `from = to` — `edge_self`.
   - ребро того же вида между той же парой уже было (у `link` пара без учёта порядка) — `edge_duplicate`.
   - `link`, у которого хотя бы один конец не агент графа — `link_requires_agents`.
4. **Потоки** (команды и агенты-входы — по 4.1).
   - `flow`, у которого источник не программа и не агент графа или цель не программа и не агент графа — `flow_requires_values`. Программы всегда дают и принимают значение (`inputs` и `outputs` обязательны для `program`, 021, 4.1.2).
   - `flow` касается агента, который не агент-вход своей команды — `flow_not_at_team_entry`, путь `edges.<j>`. Если в команду ведут входящие `flow` к разным агентам, агентом-входом считается цель первого такого ребра в массиве, остальные рёбра — `flow_not_at_team_entry`.
   - у шага больше одного входящего `flow` — `flow_fan_in` на каждое ребро после первого. У шага-входа ни одного: входящее `flow` к нему — `entry_has_input`.
   - цикл по рёбрам `flow` между шагами — `flow_cycle`, путь `edges.<j>` первого ребра цикла в порядке массива. Одно замечание на цикл.
5. **Вход, выход, достижимость.**
   - `entry` не id узла — `entry_unknown`, путь `entry`; `exit` не id узла — `exit_unknown`, путь `exit`.
   - `exit` — агент, который не агент-вход своей команды, — `exit_not_step`, путь `exit`.
   - шаг, недостижимый от шага-входа по рёбрам `flow`, — `unreachable`, путь `nodes.<i>` программы или агента-входа команды. Агенты команды достижимы вместе с её агентом-входом.

`entry_input_invalid` `checkGraph` не выдаёт: нужен текст задачи (4.9).

### 4.5. `SwarmLaunch` и `swarm.created`

```ts
// swarm.ts
export const LaunchProgram = z.strictObject({
  id: NodeId,
  type: NodeTypeRef,
  settings: z.record(z.string(), z.unknown()), // после validateSettings: с умолчаниями
  credentials: z.record(z.string(), SecretName),
});
export type LaunchProgram = z.infer<typeof LaunchProgram>;

// api → orchestrator. Строгая схема (4.6.1 спеки 001 остаётся).
export const SwarmLaunch = z.strictObject({
  swarmId: SwarmId,
  orgId: OrgId,
  task: z.string(),
  budgetMicroUsd: BudgetMicroUsd,
  maxTokens: MaxTokens.nullable(),
  agents: z.array(AgentSpec).min(1).max(GRAPH_MAX_AGENTS), // агенты графа: { ...настройки после validateSettings, id }
  programs: z.array(LaunchProgram).max(GRAPH_MAX_NODES),
  edges: z.array(GraphEdge).max(GRAPH_MAX_EDGES),
  entry: NodeId,
  exit: NodeId,
});
```

`agents` и `programs` — в порядке узлов графа. `credentials` агентов пусты по манифесту `swag/llm-agent` и в `SwarmLaunch` не передаются.

`swarm.created` (`events.ts`) получает поле `graph: ProcessGraph.optional()`: до 009 поля нет. `api` пишет туда граф роя, для формы — результат `formGraph`. `agents` события — те же `AgentSpec`, что в `SwarmLaunch`.

### 4.6. План и исполнение: `graphPlan` и `orchestrator-core`

```ts
// packages/api-integration/src/process-graph.ts
export interface TeamPlan {
  entry: NodeId; // агент-вход
  members: NodeId[]; // все агенты команды, в порядке узлов графа, вход — среди них
}

export type Step = { kind: 'program'; id: NodeId } | { kind: 'team'; id: NodeId; team: TeamPlan }; // id команды — id её агента-входа

export interface GraphPlan {
  steps: Step[]; // в порядке первого узла шага в графе
  stepOf(nodeId: NodeId): Step; // шаг узла: программа или команда, где узел — участник
  next(stepId: NodeId): NodeId[]; // цели исходящих flow шага, в порядке рёбер
  peers(agentId: NodeId): NodeId[]; // соседи по link, в порядке узлов графа
  entry: NodeId; // id шага-входа
  exit: NodeId; // id шага-выхода
}

// Вход — граф без замечаний checkGraph (агенты из SwarmLaunch.agents, программы из programs).
export function graphPlan(input: {
  agents: readonly { id: NodeId }[];
  programs: readonly { id: NodeId }[];
  edges: readonly GraphEdge[];
  entry: NodeId;
  exit: NodeId;
}): GraphPlan;

// Значение потока как текст сообщения агенту и итог роя.
export function valueText(value: unknown): string; // объект со строковым полем text — это поле; строка — она сама; иначе JSON.stringify(value)
```

**Исполнение** заменяет в `orchestrator-core` логику `ENTRY_AGENT_ID` и `agents[0]`. Подъём песочниц агентов, регистрация в gateway и таймеры остаются как сейчас.

1. При `launch` оркестратор строит план `graphPlan`. Env агента (4.8 спеки 022):
   - `AGENT_PEERS` — `plan.peers(agent.id)` с именем и ролью;
   - `AGENT_ENTRY` — id агента-входа его команды;
   - для агента-входа ещё `AGENT_TASK_FROM` и `AGENT_RESULT_TO` (4.8).
2. Когда стартовали все агенты (`checkReady`), оркестратор отдаёт задачу шагу-входу (REQ-009-9), затем публикует `swarm.started`. Порядок как сейчас: сообщение задачи, потом `swarm.started`.
3. **Шаг-программа получил вход `value`.**
   - публикуется `node.started`;
   - вызов `invokeNode` (026, 4.10): `{ orgId, type, call: { kind: 'execute', input: value }, settings, credentials, stateKey }`;
   - `ok` — `node.completed`, выход передаётся по `plan.next` (шаг 5);
   - не `ok` — `node.failed` и `finish(run, swarm.failed { reason: 'node_failed', detail: '<nodeId>: <code>' })`.
4. **Шаг-команда получил вход `value` от шага `source`.** Оркестратор публикует сообщение шины агенту-входу: `from: source`, `text: valueText(value)`.
5. **Передача выхода.** Выход шага передаётся каждой цели `plan.next(stepId)` параллельно, по порядку рёбер. Цели нет — выход только запоминается.
6. **Выход команды.** `agent.result` агента-входа команды даёт выход `{ text: result }`. Оркестратор убирает песочницы агентов команды так же, как в `finish` (`agent.stopped` на каждого), и передаёт выход дальше (шаг 5). `agent.result` не агента-входа игнорируется.
7. **Завершение.** Шаг завершён, когда дал выход. Рой завершается `swarm.completed { result: valueText(выход шага-выхода) }` в тот момент, когда шаг-выход завершён и не осталось начатых незавершённых шагов. Ответ вызова программы, пришедший после завершения роя, игнорируется без событий. Таймеры, `stop`, `agent.failed` и бюджет работают как сейчас.

Обработка `node.*` и `agent.result` идёт так же последовательно, как остальные события роя в `handleEvent`: шаг не может получить вход дважды (≤1 входящий `flow`, 4.4).

### 4.7. `stateKey` узла графа

`stateKey = "swarm:<swarmId>:<nodeId>"` (≤ 200 символов: 6 + 36 + 1 + 40). Состояние живёт в пределах одного роя. Ключ для сохранённого процесса (`process:<processId>:<nodeId>`) — в спеке 033 (Q-10).

### 4.8. Промпт агента-входа команды: `packages/agent-core/src/prompt.ts`, `packages/config`

Новые env агента в `AgentConfig` (`packages/config`):
- `AGENT_TASK_FROM: z.union([AgentId, z.literal('user')]).default('user')`;
- `AGENT_RESULT_TO: z.enum(['user', 'process']).default('user')`.

Оркестратор передаёт их только агенту-входу: `AGENT_TASK_FROM` — `user` для шага-входа, иначе id шага-источника его входящего `flow`; `AGENT_RESULT_TO` — `user`, если команда — шаг-выход, иначе `process`.

`PromptAgent` получает поля `taskFrom: AgentId | 'user'` и `resultTo: 'user' | 'process'`. Строка агента-входа в `systemPrompt` собирается из двух частей:

| Условие | Текст |
|---|---|
| `taskFrom = 'user'` | `Задачу тебе ставит пользователь.` |
| `taskFrom` — шаг | `Задачу тебе передаёт шаг процесса <taskFrom>.` |
| `resultTo = 'user'` | `Когда задача решена, вызови finish с итоговым результатом: его получит пользователь.` |
| `resultTo = 'process'` | `Когда задача решена, вызови finish с итоговым результатом: он уйдёт следующему шагу процесса.` |

При `user` + `user` строка совпадает с `ENTRY_LINE` 022 побайтно (REQ-009-17). Описание `finish` — `Завершить задачу и вернуть итог пользователю` при `resultTo = 'user'`, иначе `Завершить задачу и вернуть итог следующему шагу процесса`.

`inboxMessage`: отправитель не `user` и не участник (`peers`) — `{ role: 'user', content: 'Вход от шага процесса <from>:\n<text>' }`. Остальные случаи как в 022.

### 4.9. API `api`

| Метод и путь | Право | Тело | Ответ | Ошибки |
|---|---|---|---|---|
| `POST /swarms` | `swarm.create` | `SwarmRequest` | `201 SwarmView` | как сейчас + `400 invalid_graph` |
| `POST /graph-checks` | `swarm.create` | `ProcessGraph` | `200 GraphCheckResult` | `400 validation_error` (тело не `ProcessGraph`), `401`, `403 forbidden` |

`createSwarm`, порядок шагов:
1. Право `swarm.create`; разбор `SwarmRequest` — ошибка `validation_error`, как сейчас.
2. Форма → `formGraph(agents)`.
3. `actor.orgId !== null` (как сейчас); `checkGraph(graph, { registry: deps.nodeTypes, secretNames: имена из secrets.list(orgId) })`.
4. Шаг-вход — программа: `registry.validate(type, { place: 'inputs' }, { text: task })` не `ok` — замечание `entry_input_invalid`, путь `entry`.
5. Есть замечания — `400 { error: { code: 'invalid_graph', message: 'graph has issues', issues } }`, где `issues` — `{ path, message: '<code>: <message>' }` в формате `ApiError` (полный `GraphIssue` отдаёт `POST /graph-checks`).
6. Проверки бюджета и `maxTokens` по агентам графа, лимит активных роёв, резерв, `swarm.created`, `launch` — как сейчас. Настройки агентов — `settings` из `validateSettings`.

`checkGraphFor(actor, body)` в `api-core` — операция для `POST /graph-checks`: шаги 1, 3 без резерва и событий. Без `orgId` секреты считаются пустым множеством.

### 4.10. События и проекция

```ts
// events.ts, в PlatformEventInput; source 'orchestrator', agentId null
z.strictObject({ ...Envelope, type: z.literal('node.started'), data: z.strictObject({ nodeId: NodeId, type: NodeTypeRef }) }),
z.strictObject({ ...Envelope, type: z.literal('node.completed'), data: z.strictObject({ nodeId: NodeId, durationMs: z.number().int().min(0) }) }),
z.strictObject({
  ...Envelope,
  type: z.literal('node.failed'),
  data: z.strictObject({ nodeId: NodeId, code: NodeInvocationErrorCode, message: z.string().max(1000), durationMs: z.number().int().min(0) }),
}),
```

`swarm.failed.data.reason` получает значение `node_failed`.

`SwarmView` (`packages/api-integration/src/swarm-view.ts`) получает:

```ts
nodes: {
  id: NodeId;
  type: NodeTypeRef;
  status: 'waiting' | 'running' | 'completed' | 'failed';
  durationMs: number | null;
}[]; // программы графа в порядке узлов
```

- `swarm.created` с `graph` создаёт по элементу на программу графа: `waiting`, `durationMs: null`; без `graph` — `nodes: []`;
- `node.started` → `running`;
- `node.completed` → `completed` + `durationMs`;
- `node.failed` → `failed` + `durationMs`.

`ui-core` (`swarm-ui.ts`):
- `formatNodeEvent(event)` — строка ленты: `<nodeId> запущен`, `<nodeId> завершён за <durationMs> мс`, `<nodeId>: ошибка <code> — <message>`;
- `failureReasonText('node_failed')` — `ошибка шага процесса`.

Страница роя кабинета (`apps/ui/cabinet/src/app/swarm.page.ts`) показывает `nodes` списком под агентами (id, тип, статус, длительность), если список не пуст, а события `node.*` — строками `formatNodeEvent` в ленте.

## 5. Критерии приёмки

- **AC-009-1** — *Given* форма из 3 агентов *When* `formGraph` *Then* узлы `agent-1…3` с типом `swag/llm-agent@1.0.0` и настройками формы, рёбра `link` (1,2), (1,3), (2,3), `entry = exit = 'agent-1'`.
- **AC-009-2** — *Given* граф `agent-1 —link— agent-2`, `entry = exit = agent-1`, реестр 021 *When* `checkGraph` *Then* `{ ok: true, issues: [] }`.
- **AC-009-3** — *Given* граф с двумя узлами `a`, неизвестным типом и узлом `test/trigger@1.0.0` вида `trigger` в тестовом реестре *When* `checkGraph` *Then* замечания `node_duplicate`, `node_type_not_found`, `node_kind_unsupported` с путями 4.4, все в одном результате (REQ-009-4).
- **AC-009-4** — *Given* агент с `role: ''` и программа с лишним ключом `credentials` *When* `checkGraph` *Then* `invalid_settings` с путём `nodes.<i>.settings.role` и `credentials_mismatch`.
- **AC-009-5** — *Given* программа тестового реестра с credential `apiKey` → `missing-key`, которого нет в `secretNames` *When* `checkGraph` *Then* `secret_not_found` с путём `nodes.<i>.credentials.apiKey`; с `secretNames = {'missing-key'}` — без замечаний.
- **AC-009-6** — *Given* рёбра: на неизвестный узел, петля, дубль `link` в обратном порядке, `link` агент–программа *When* `checkGraph` *Then* `edge_unknown_node`, `edge_self`, `edge_duplicate`, `link_requires_agents`.
- **AC-009-7** — *Given* команда `a —link— b`, `flow p → b` при `entry = a` *When* `checkGraph` *Then* `flow_not_at_team_entry`, потому что агент-вход команды — `a`.
- **AC-009-8** — *Given* два `flow` в одну программу и `flow` в шаг-вход *When* `checkGraph` *Then* `flow_fan_in` на второе ребро и `entry_has_input`.
- **AC-009-9** — *Given* цикл `p1 → p2 → p1` по `flow` и цикл `a —link— b —link— c —link— a` *When* `checkGraph` *Then* одно `flow_cycle`, за цикл связей замечаний нет.
- **AC-009-10** — *Given* программа без входящего `flow`, `exit` — не агент-вход, `entry` и `exit` — неизвестные id (отдельные графы) *When* `checkGraph` *Then* `unreachable`, `exit_not_step`, `entry_unknown`, `exit_unknown`.
- **AC-009-11** — *Given* 9 агентов; граф только из программ *When* `checkGraph` *Then* `too_many_agents`; `no_agents`.
- **AC-009-12** — *Given* граф `echo → agent-1`, `entry = echo`, `exit = agent-1` *When* `POST /swarms` с задачей *Then* `201`; `swarm.created.data.graph` — граф; `SwarmLaunch` с `orgId`, `agents`, `programs` (настройки echo с `prefix: ''`), `edges`, `entry`, `exit`.
- **AC-009-13** — *Given* граф с замечаниями *When* `POST /swarms` *Then* `400 invalid_graph`, `issues` в формате `ApiError` со всеми замечаниями, нет `swarm.created`, нет резерва в `BillingCore`, нет вызова оркестратора.
- **AC-009-14** — *Given* шаг-вход — программа со схемой `inputs`, которая не принимает `{ text }` *When* `POST /swarms` *Then* `400 invalid_graph` с `entry_input_invalid`.
- **AC-009-15** — *Given* граф с замечаниями и без *When* `POST /graph-checks` *Then* `200 GraphCheckResult` с полными `GraphIssue`; нет событий, резервов и вызовов оркестратора. Без права `swarm.create` — `403`.
- **AC-009-16** — *Given* форма из 2 агентов *When* рой идёт до `finish` `agent-1` в `orchestrator-core` на фейках *Then* последовательность событий и env агентов (`AGENT_PEERS`, `AGENT_ENTRY`) совпадает с поведением до 009 (REQ-009-17).
- **AC-009-17** — *Given* `SwarmLaunch` с командой `a —link— b`, отдельным агентом `c`, программой `p`, рёбрами `flow p → a`, `a → c`, `entry = p`, `exit = c` *When* `graphPlan` *Then* шаги `p`, команда `a{a,b}`, команда `c{c}`; `peers(a) = [b]`, `peers(c) = []`; `next(p) = [a]`, `next(a) = [c]`.
- **AC-009-18** — *Given* граф AC-009-17 на фейках оркестратора, фейк `invokeNode` отдаёт `{ text: 'x' }` *When* все агенты стартовали *Then* `node.started p` → вызов `execute` со входом `{ text: task }` и `stateKey = swarm:<id>:p` → `node.completed p` → сообщение шины `from: 'p'`, `to: 'a'`, `text: 'x'` → `swarm.started` идёт после передачи задачи шагу-входу.
- **AC-009-19** — *Given* продолжение AC-009-18 *When* `a` публикует `agent.result 'r1'` *Then* песочницы `a` и `b` убраны с `agent.stopped`, `c` получает сообщение `from: 'a'`, `text: 'r1'`, рой не завершён; *When* `c` публикует `agent.result 'r2'` *Then* `swarm.completed { result: 'r2' }`.
- **AC-009-20** — *Given* фейк `invokeNode` отдаёт `{ ok: false, code: 'timeout' }` *When* программа получает вход *Then* `node.failed { code: 'timeout' }` и `swarm.failed { reason: 'node_failed', detail: 'p: timeout' }`.
- **AC-009-21** — *Given* шаг-выход завершён, а вызов программы в боковой ветке ещё идёт *When* выход шага-выхода получен *Then* рой не завершён; *When* программа ответила *Then* `swarm.completed`. Ответ программы после `swarm.stopped` не даёт событий.
- **AC-009-22** — *Given* `agent.result` агента команды, который не агент-вход *When* `handleEvent` *Then* шаг не завершается, рой не меняется.
- **AC-009-23** — *Given* env агента-входа со всеми сочетаниями `AGENT_TASK_FROM` и `AGENT_RESULT_TO` *When* `systemPrompt` и `swarmTools` *Then* строки и описание `finish` по таблице 4.8; при `user` + `user` строка равна `ENTRY_LINE`. `inboxMessage` от не-участника `p` — `Вход от шага процесса p:\n…`.
- **AC-009-24** — *Given* события `swarm.created` с графом из 2 программ, `node.started`, `node.completed`, `node.failed` *When* проекция `SwarmView` *Then* `nodes` со статусами и `durationMs` по 4.10; без `graph` — `nodes: []`.
- **AC-009-25** — *Given* `formatNodeEvent` и `failureReasonText` *When* три вида `node.*` и `node_failed` *Then* строки 4.10.
- **AC-009-26** — *Given* настройки программы с маркером `settings-marker-009` и вход с маркером `input-marker-009` *When* рой AC-009-18 *Then* маркеров нет в событиях и в логах оркестратора и `api` (REQ-009-20).
- **AC-009-27** `[manual]` — *Given* стек `npm run up`, вход пользователем кабинета *When* `POST /swarms` с графом `echo (prefix «> ») → agent-1 —link— agent-2`, `entry = echo`, `exit = agent-1`, задача «напиши одно предложение о море» *Then* рой `completed`; на странице роя echo `completed` с длительностью; в ленте `node.started`, `node.completed`, затем сообщение от `echo` агенту `agent-1`, текст начинается с «> ». Проверка: curl с токеном из входа, затем страница роя в браузере; результат в журнал.
- **AC-009-28** `[manual]` — *Given* тот же стек *When* рой создан из формы кабинета с 2 агентами *Then* рой идёт и завершается как до 009, страница роя без списка программ.

## 6. Нефункциональные требования

| ID | Требование | Как измеряется |
|---|---|---|
| NFR-009-1 | `checkGraph` графа из 16 узлов и 64 рёбер — p95 < 5 мс | тест-замер на 1000 прогонах в `api-integration`, результат в журнал |

## 7. Безопасность: что не должно сломаться

- Оркестратор исполняет только граф, проверенный `api`: строгий `SwarmLaunch`, `api` — единственный, кто знает `ORCHESTRATOR_TOKEN` → AC-009-12, AC-009-13, тесты `POST /swarms` 001.
- Узел графа не получает чужие секреты: credentials проверяются по манифесту и секретам своей организации, `orgId` вызова — организация роя → AC-009-4, AC-009-5, AC-009-18.
- Настройки и вход узлов не утекают в события и логи → AC-009-26.
- Форма роя ведёт себя как до 009: те же события, промпт и участники → AC-009-16, AC-009-23, AC-009-28.
- Граф не даёт бесконечного исполнения потоков: циклы `flow` отклоняются, остальное ограничено `SWARM_TIMEOUT_MS` → AC-009-9.
- Состояние узлов разных роёв не пересекается → `stateKey` 4.7, AC-009-18.

## 8. Задачи для агента

Выполняются по порядку. После каждой задачи — коммит.

- [x] **T-1.** Контракты графа: `packages/contracts/src/graph.ts` по 4.1, экспорт в `index.ts`; в `swarm.ts` `AgentId = NodeId`, `SwarmGraphRequest`, `SwarmRequest`, `LaunchProgram`, новый `SwarmLaunch` (4.2, 4.5); в `events.ts` `graph` в `swarm.created`, `node.*`, `node_failed` (4.5, 4.10). Тесты схем в `packages/contracts` (`NodeId` отклоняет `user`, `SwarmRequest` различает форму и граф). Закрывает: REQ-009-1 (контракт), REQ-009-7 (контракт), REQ-009-18 (контракт). Готово, когда: схемы по 4.1–4.10 и `npm run typecheck` по пакету `contracts` зелёные. Оркестратор и `api` компилируются на следующих задачах группы — **группа T-1…T-6 через фича-ветку `spec/009-graph`**.
- [x] **T-2.** `formGraph` и `checkGraph` в `packages/api-integration/src/process-graph.ts` (4.3, 4.4), экспорт из пакета; тестовый реестр — из манифестов `swag/llm-agent`, `example/echo` и тестовых манифестов `trigger` и `program` с credential в файле теста. Закрывает: REQ-009-3, REQ-009-4, AC-009-1…AC-009-11, NFR-009-1. Готово, когда: тесты AC зелёные, замер NFR в журнале.
- [x] **T-3.** `graphPlan` и `valueText` в том же файле (4.6). Закрывает: REQ-009-8, AC-009-17. Готово, когда: тест AC-009-17 и тесты `valueText` (объект с `text`, строка, прочее) зелёные.
- [x] **T-4.** `api-core`: `createSwarm` по 4.9 (разбор `SwarmRequest`, `formGraph`, `checkGraph` с `secrets.list`, `entry_input_invalid`, `invalid_graph`, `SwarmLaunch` 4.5, `graph` в `swarm.created`), операция `checkGraphFor`; маршрут `POST /graph-checks` и код `invalid_graph` → `400` в `apps/api/src/app.ts`. Закрывает: REQ-009-1, REQ-009-2, REQ-009-5, REQ-009-6, REQ-009-7, AC-009-12…AC-009-15. Готово, когда: тесты AC и прежние тесты `api-core` и `apps/api` зелёные.
- [ ] **T-5.** `agent-core` и `config`: `AGENT_TASK_FROM`, `AGENT_RESULT_TO` в конфиге агента, поля `PromptAgent`, строки и `finish` по 4.8, `inboxMessage` от не-участника; передача в `apps/agent/src/start.ts`. Закрывает: REQ-009-16, AC-009-23. Готово, когда: тест AC-009-23 и прежние тесты промпта 022 зелёные без правки ожиданий.
- [ ] **T-6.** `orchestrator-core`: исполнение по 4.6 через `graphPlan` (env агентов, задача шагу-входу, программы через `invokeNode` со `stateKey` 4.7, `node.*`, выход команды и уборка её песочниц, завершение по шагу-выходу, `node_failed`); убрать `ENTRY_AGENT_ID` и `agents[0]` из ядра. Закрывает: REQ-009-9…REQ-009-15, REQ-009-17, REQ-009-20, AC-009-16, AC-009-18…AC-009-22, AC-009-26. Готово, когда: тесты AC и прежние тесты оркестратора зелёные; `npm run check` зелёный; фича-ветка `spec/009-graph` влита в `main`.
- [ ] **T-7.** Проекция `SwarmView.nodes` в `packages/api-integration/src/swarm-view.ts` (4.10). Закрывает: REQ-009-18, AC-009-24. Готово, когда: тест AC-009-24 и прежние тесты проекции зелёные.
- [ ] **T-8.** `ui-core`: `formatNodeEvent`, `failureReasonText('node_failed')` в `swarm-ui.ts`, экспорт. Закрывает: AC-009-25. Готово, когда: тест AC-009-25 зелёный.
- [ ] **T-9.** Страница роя `apps/ui/cabinet/src/app/swarm.page.ts`: список `nodes` и строки `node.*` в ленте (4.10). Закрывает: REQ-009-19. Готово, когда: `npm run check` зелёный, страница собирается.
- [ ] **T-10.** Глоссарий, README пакетов `contracts`, `api-integration`, `api-core`, `orchestrator-core`, `agent-core`, `config`, `ui-core`, `apps/api`, `apps/ui`, раздел о графе в `docs/architecture.md`; ручные AC-009-27, AC-009-28 с результатом в журнал. Закрывает: AC-009-27, AC-009-28. Готово, когда: README сверены с кодом, проверки в журнале.

## 9. Открытые вопросы

Пока список не пуст, спека не может быть `ready`.

- [x] **Q-1. Объём спеки.** Строка реестра включает триггеры запуска, бота как вид процесса и рой как узел графа. Вместе с графом и исполнением это примерно 25 задач в шести пакетах. Варианты:
  - **(а)** 009 — граф, проверка, исполнение смешанного графа и рой как узел внутри графа (команда), как в черновике. Новая спека «Сохранённый процесс и запуск по триггеру»: определение процесса отдельно от активаций, CRUD, включение, опрос `poll` триггеров с курсором, активация на событие с бюджетом активации, процесс как узел другого процесса. Она идёт перед 018, бот 018 строится на ней.
  - **(б)** всё в 009 — спека вдвое больше, триггеры без сохранённого процесса не работают, так что сохранённый процесс тоже попадает сюда.
  - **(в)** 009 только контракт и проверка графа, исполнение — отдельной спекой.

  Рекомендация — **(а)**: черновик уже даёт рой как граф и проверяемый результат (программа + команда агентов). Триггеру нужен процесс, который живёт без пользователя, а это отдельная тема: хранение, включение, бюджет активации. *(Claude, 2026-11-03)*
  **Ответ (человек, 2026-11-03):** (а). Новая спека — 033 «Сохранённый процесс и запуск по триггеру», строка в реестре после 009.
- [x] **Q-2. Правила исполнения смешанного графа** *(из D-22)*. В черновике приняты такие правила, подтвердить или поправить:
  - шаг завершён по выходу: программа — по ответу `invokeNode`, команда — по `finish` агента-входа; таймаут — общий `SWARM_TIMEOUT_MS`;
  - агент может быть одновременно в потоке и в связях, но потоки касаются только агента-входа своей команды;
  - тупики (шаги без исходящего потока) допустимы, итог даёт явный `exit`; недостижимые шаги отклоняются; циклы `flow` запрещены, циклы `link` разрешены;
  - вход и выход проверяются схемами манифеста в момент передачи. Агент принимает текст `valueText` и отдаёт `{ text }`. Статической проверки совместимости схем и маппинга полей нет;
  - `edges` из 001 («кто кому пишет») становятся рёбрами `link`; полная связность формы — частный случай.
  *(Claude, 2026-11-03)*
  **Ответ (человек, 2026-11-03):** по рекомендации — правила подтверждены, как в черновике.
- [x] **Q-3. Рой как узел графа** *(из D-77)*. В черновике рой как узел — это команда агентов внутри графа: вход потока идёт агенту-входу, `finish` даёт выход, после выхода песочницы команды убираются. Остальное:
  - **память между активациями** — в 009 каждый рой с чистого листа (а); помнить прошлые активации — вместе с 018;
  - **работа пришла, пока рой активен** — каждый `POST /swarms` — отдельный экземпляр (б) в пределах `MAX_ACTIVE_SWARMS`; очередь на сохранённый процесс — в спеке 033;
  - **источник задачи** — `BusMessage.from` = id шага-источника, промпт «задачу тебе передаёт шаг процесса <id>», итог `finish` уходит по исходящим потокам (4.6, 4.8);
  - **вложенность** (процесс как узел другого процесса, деление бюджета и таймаута) — в спеку 033.
  Рекомендация — так и оставить. *(Claude, 2026-11-03)*
  **Ответ (человек, 2026-11-03):** по рекомендации — оставить, как в черновике.
- [x] **Q-4. Бот как процесс** *(из D-28)*. Подтвердить трактовку: процесс — граф. Виды процесса различаются тем, что его запускает: рой — задача пользователя (009), процесс по триггеру — событие (спека 033), бот — триггер канала с экземпляром процесса на диалог (018). Настройки бота — настройки узла LLM-агента. Рекомендация — подтвердить; в 009 под бота ничего не делается, D-28 закрывается здесь, а 018 берёт жизненный цикл диалога. *(Claude, 2026-11-03)*
  **Ответ (человек, 2026-11-03):** по рекомендации — трактовка подтверждена, D-28 закрыт здесь, жизненный цикл диалога — в 018.
- [x] **Q-5. Где проверяется граф** *(из D-157)*. В черновике (б): `api` проверяет граф в `api-core` и передаёт в `SwarmLaunch` настройки после проверки, оркестратор доверяет `api` и реестр для проверки не использует. Свой реестр (026, Q-5 «а») ему нужен только для вызова программы. Рекомендация — (б), как бюджет и `maxTokens` сейчас. *(Claude, 2026-11-03)*
  **Ответ (человек, 2026-11-03):** по рекомендации — (б): граф проверяет `api`, оркестратор доверяет настройкам из `SwarmLaunch`.
- [x] **Q-6. Слияние потоков.** В 009 у шага не больше одного входящего `flow` (`flow_fan_in`). Ветвление (fan-out) есть, слияния нет: для него нужен формат входа из нескольких выходов (объект по id источников или массив) и правило «ждать все или первый». Варианты: **(а)** без слияния в 009, добавить вместе с маппингом полей в 017/027; **(б)** слияние в 009 — вход `{ [sourceId]: value }`, ждать все входы. Рекомендация — **(а)**: цепочки и ветвления покрывают первые сценарии, а формат слияния лучше выбирать вместе с редактором. *(Claude, 2026-11-03)*
  **Ответ (человек, 2026-11-03):** по рекомендации — (а): слияния в 009 нет, вместе с маппингом полей в 017/027.
- [x] **Q-7. Направление ребра `link`.** В черновике `link` неориентированное: оба агента пишут друг другу, как сейчас в форме. Вариант — ориентированное «кто кому пишет», ответ только по обратному ребру. Рекомендация — неориентированное: ответить отправителю нужно почти всегда, а направленность даёт ошибки сборки графа. *(Claude, 2026-11-03)*
  **Ответ (человек, 2026-11-03):** по рекомендации — неориентированное.
- [x] **Q-8. `AgentId` = `NodeId`.** Чтобы агенты графа именовались id узлов (`writer`, `critic`), `AgentId` расширяется с `agent-1…99` до `[a-z][a-z0-9-]{0,39}`, кроме `user`. Затрагивает схемы шины, событий и проекции, старые события остаются валидны. Альтернатива — агентам графа выдавать `agent-N`, а id узла хранить отдельно; тогда в событиях два id. Рекомендация — расширить. *(Claude, 2026-11-03)*
  **Ответ (человек, 2026-11-03):** по рекомендации — расширить `AgentId` до формата `NodeId`.
- [x] **Q-9. Лимиты графа.** В черновике: узлов ≤ 16, рёбер ≤ 64, агентов ≤ 8 (как сейчас). Подтвердить числа или назвать свои; вынести ли их в env (`GRAPH_MAX_NODES` и т. п.). Рекомендация — константы в контрактах, env — когда понадобится разный лимит по тарифу. *(Claude, 2026-11-03)*
  **Ответ (человек, 2026-11-03):** по рекомендации — 16 узлов, 64 ребра, 8 агентов — константы в контрактах, без env.
- [x] **Q-10. `stateKey` узла.** 026 говорит «`stateKey` — id узла графа». Пока процессы не сохраняются, один id узла (`p`) в разных роях организации дал бы общее состояние. В черновике `swarm:<swarmId>:<nodeId>` — состояние на рой. У сохранённого процесса (Q-1) — `process:<processId>:<nodeId>`, состояние переживает активации. Рекомендация — так. *(Claude, 2026-11-03)*
  **Ответ (человек, 2026-11-03):** по рекомендации — `swarm:<swarmId>:<nodeId>` в 009, `process:<processId>:<nodeId>` — в 033.

## 10. Журнал реализации

Заполняет агент.

| Дата | Ветка / коммит | Что сделано | Отклонения от спеки |
|---|---|---|---|
| 2026-11-03 | `spec/009-graph` | Группа T-1…T-6 через фича-ветку `spec/009-graph`: T-1 меняет `SwarmLaunch` и `AgentId` в `contracts`, оркестратор, `api` и агент компилируются только после T-4…T-6. Каждая задача группы — этап `spec/009-tN` с PR в фича-ветку; фича-ветка — в `main` после T-6. | — |
| 2026-11-03 | `spec/009-t2` | T-2: `formGraph` и `checkGraph` в `packages/api-integration/src/process-graph.ts`, экспорт из пакета; тесты AC-009-1…AC-009-11 в `test/process-graph.test.ts` (тестовый реестр — манифесты `swag/llm-agent`, `example/echo` и литеральные `test/trigger`, `test/program` с credential `apiKey`). NFR-009-1: `checkGraph` на 16 узлах и 64 рёбрах, 1000 прогонов после 50 прогрева, p50 0,038–0,039 мс, p95 0,076–0,138 мс (четыре прогона) при пороге 5 мс. | Трактовки (D-177…D-179 в `questions.md`): `flow_cycle` одно на компоненту сильной связности; `flow_requires_values` не выдаётся (мёртвая проверка); уточнения 4.4 о рёбрах и узлах вне участников. Валидного графа на 64 ребра не бывает (не больше 36 рёбер: 28 `link` между 8 агентами и не больше 8 `flow`), замер — 28 повторов `link`. |
| 2026-11-03 | `spec/009-t2` | T-3: `graphPlan` и `valueText` в `packages/api-integration/src/process-graph.ts` (4.6); общий расчёт команд `teamEntries` для `checkGraph` и `graphPlan` (4.1). Тесты AC-009-17 и `valueText` (объект с `text`, строка, прочее) в `test/process-graph.test.ts`, все 48 тестов пакета зелёные. | Порядок `steps` (программы, затем команды) — трактовка, см. D-180 в `questions.md`: вход `graphPlan` не несёт общего порядка узлов. |
| 2026-11-03 | `spec/009-t2` | Замечания ревью T-2 и T-3: тест AC-009-9 — граф из цикла `link` a–b–c даёт `issues: []`; AC-009-6, 7, 8 сверяют полный список кодов; `flow` между агентами одной команды не даёт `flow_cycle` (петли шага на себя исключены из обхода циклов, D-179); `valueText(undefined)` возвращает `'null'`. | Полные списки кодов расходятся с буквой AC-009-6, 7, 8: добавляется `unreachable` для программ без входящего `flow` (4.4, проход 5), которого критерии не называют. Тесты сверяют фактический полный список; код не менялся. |
| 2026-11-03 | `spec/009-t4` | T-4: `createSwarm` по 4.9 (`parseRequest`, `graphCheck` с `secrets.list`, `entry_input_invalid`, `invalid_graph`, `launchNodes` по `validateSettings`, `SwarmLaunch` 4.5, `graph` в `swarm.created`), `checkGraphFor` и `POST /graph-checks`, `invalid_graph` → 400 в `app.ts`. Тесты AC-009-12…15 и AC-009-5 (ядро) в `packages/api-core/test/api-core.test.ts`, HTTP — `apps/api/test/graph-http.test.ts`. `api-core` и `apps/api`: 129 тестов зелёные; шесть падений e2e/trace из базы зелёные. Вероятная причина: `orchestrator-core` разбирает `SwarmLaunch` строго (`safeParse`), старая форма отвергалась; на HEAD отдельно не проверялось. | Вид тела — по полю `graph` (D-181); `entry_input_invalid` не в `POST /graph-checks` (D-182); текст замечания входа (D-183). Тестовые реестры содержат `swag/llm-agent` (`formNodeTypes`, без него форма не проходит `checkGraph`); `AC-021-20` передаёт пустой реестр явно. |
