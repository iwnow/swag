---
id: "001"
title: Сквозной скелет без LLM
status: blocked
roadmap_stage: 1
depends_on: ["000"]
superseded_by: null
updated: 2026-10-22
---

# 001. Сквозной скелет без LLM

> **Коротко.** Первый работающий сценарий платформы от начала до конца, без модели.
> - **Что появится.** В UI пользователь задаёт рою задачу и агентов с ролями и жмёт «Запустить». Дальше по цепочке:
>   - `api` создаёт рой;
>   - `orchestrator` поднимает по Docker-контейнеру на агента;
>   - агенты передают задачу друг другу по цепочке через NATS — «эстафета»: каждый дописывает строку от своей роли;
>   - последний агент отдаёт результат.
>
>   UI в реальном времени показывает граф роя со статусами агентов, ленту сообщений и результат. Есть кнопка «Стоп». После роя контейнеров не остаётся.
> - **Цепочка компонентов.** UI (Angular) → HTTP → `api` → HTTP → `orchestrator` → Docker → агенты ↔ NATS → `api` → WebSocket → UI. Все события идут через NATS, `api` их собирает, нумерует и раздаёт UI.
> - **Чего нет.** Модели, денег, входа пользователей и базы данных: рои и события хранятся в памяти `api` и теряются при перезапуске. Изоляции роёв, тёплого пула и лимитов контейнеров тоже нет. Всё это — следующие этапы.
> - **Новые пакеты.**
>   - адаптеры `adapter-docker`, `adapter-nats`, `adapter-memory`, `adapter-orchestrator-http`;
>   - `api-integration` — общая чистая логика для `api-core` и `ui-core` (проекция роя из событий);
>   - ядро `ui-core` и фронтенд личного кабинета `apps/ui/cabinet`. `apps/ui/` — папка фронтендов платформы, каждый собирается и деплоится отдельно; остальные — в 014 и позже.
>
>   Ядра `api-core`, `orchestrator-core` и `agent-core` получают первую настоящую логику.
> - **Главный автотест** проходит весь сценарий без Docker и сети: три ядра, шина в памяти и фейковый провайдер песочниц. Настоящий запуск в Docker и UI проверяется вручную.
> - **Из бэклога** забраны N-1 (список пакетов в Dockerfile) и N-3 (`arch:check` для `contracts`).
> - **Песочница не привязана ни к Docker, ни к агенту.** Порт `SandboxProvider` описывает шаблон, env и метаданные; Docker — первый адаптер, microVM и E2B встанут за тот же порт, а в песочнице позже можно выполнять любую работу.
> - **Решения человека (Q-1…Q-6):**
>   - Docker socket монтируется только в `orchestrator`;
>   - цепочка по порядку агентов;
>   - лимиты по предложению;
>   - `ng serve` с прокси и свой SVG-граф;
>   - проекция роя — в новом пакете `@swag/api-integration`;
>   - `api` → `orchestrator` по HTTP.
>
>   Открытых вопросов нет, спека ждёт статуса `ready` от человека.

## 1. Контекст и цель

Этап 1 [роадмапа](../../AI_PLATFORM_ROADMAP.md#этапы) — сквозной скелет. Сейчас после спеки 000 есть каркас: ядра-заглушки с `info()`, оболочки с `/health`, Postgres и NATS в compose, образ агента, который печатает `agent ok`.

Цель — тонкая, но настоящая цепочка через все звенья платформы, которую видно в UI. На ней следующие этапы утолщают по одному звену, не перестраивая остальные: модель (002), хранение (003), деньги (004), пользователи (012–014), песочницы (005), изоляция шины (007).

Поведение агента в этой спеке детерминированное — «эстафета» вместо LLM. Поэтому весь сценарий проверяется автотестом с точным ожидаемым результатом.

## 2. Объём

**Входит:**
- контракты в `@swag/contracts`: запрос на рой, рой, агент, запуск роя, сообщение шины, события платформы, subjects NATS, проекция роя из событий (4.1–4.4);
- `api`: REST для роёв, WebSocket-поток событий роя, сбор событий и сообщений из NATS, хранение в памяти (4.5);
- `orchestrator`: запуск и остановка роя, контейнер на агента через Docker, ожидание готовности агентов, таймауты, уборка контейнеров (4.6);
- `agent`: процесс в контейнере, подписка на свои входящие, сценарий «эстафета» (4.7);
- адаптеры: Docker (`SandboxProvider`), NATS (шина), хранилище роёв в памяти, HTTP-клиент оркестратора;
- UI на Angular в `apps/ui/cabinet`: список роёв, форма нового роя, страница роя с графом, лентой, результатом и кнопкой «Стоп» (4.8);
- `compose.yaml`: сервис `ui`, доступ оркестратора к Docker (по Q-1), сборка образа агента в `npm run up`;
- `arch:check` проверяет и `contracts` (из N-3), Dockerfile без ручного списка пакетов (из N-1);
- README новых пакетов, обновление README затронутых.

**Не входит** (агент это не делает, даже если кажется логичным):
- LLM, LiteLLM, агентный цикл, инструменты агента — спека 002;
- Postgres для роёв и событий, миграции, история после перезапуска — спека 003. В 001 `api` к базе не обращается;
- деньги, ledger, бюджеты, стоимость — спека 004;
- пользователи, вход, роли, проверка доступа, `Actor` — спеки 012–014. В 001 один локальный пользователь без входа;
- другие провайдеры песочниц — microVM на Firecracker, E2B (роадмап, этап 15). Порт `SandboxProvider` уже не зависит от Docker: сеть, адрес NATS и образ — конфигурация адаптера;
- тёплый пул, лимиты CPU и памяти, gVisor, read-only rootfs, сеть на рой, volume `/work`, reaper по TTL — спека 005;
- отдельный NATS account на рой, JetStream, KV, автотест изоляции A/B — спека 007. В 001 core NATS без JetStream, рои разделены только subjects;
- отслеживание падения контейнера через `docker events`, возобновление агента — спека 008. Упавший агент в 001 приводит к таймауту роя;
- координатор и план роя от LLM, произвольный граф связей (`edges`) — спека 009;
- скиллы — спека 010;
- библиотека для отрисовки графа, «машина времени» по шагам, панель денег в UI;
- production-сборка UI, деплой, HTTPS;
- каркас `apps/ui/shell`, микрофронтенды (federation), админка организации `apps/ui/admin`, супервизор `apps/ui/supervisor` — спека 014; лендинг `apps/ui/landing` на Astro — вне MVP. В 001 `apps/ui/cabinet` — самостоятельное Angular-приложение, которое в 014 станет remote каркаса.

## 3. Требования

| ID | Требование | Приоритет |
|---|---|---|
| REQ-001-1 | Пользователь MUST создать рой из UI: задача и упорядоченный список агентов (имя, роль). Порядок списка задаёт цепочку: агент `agent-k` передаёт результат `agent-(k+1)`, последний отдаёт результат роя. | MUST |
| REQ-001-2 | `api` MUST проверять запрос на рой схемой `SwarmCreateRequest` и лимитами из 4.9 и отвечать по контракту 4.5, ошибки — в формате 4.5.3. | MUST |
| REQ-001-3 | `api` MUST хранить рои и их события в памяти через порт хранилища `SwarmStore`. Замена на Postgres в 003 — новый адаптер, без правки `api-core`. | MUST |
| REQ-001-4 | `api` MUST собирать все события роя из NATS (`swarm.*.events`) и все сообщения агентов (`swarm.*.agent.*.inbox`), присваивать событиям сквозной номер `seq` внутри роя (1, 2, 3… без пропусков) и превращать каждое сообщение шины в событие `bus.message`. | MUST |
| REQ-001-5 | `api` MUST отдавать события роя по WebSocket (4.5.2): сначала все с `seq` больше `after`, затем новые по мере поступления, по возрастанию `seq`, без пропусков и повторов. | MUST |
| REQ-001-6 | Событие, не прошедшее схему `PlatformEventInput`, и сообщение, не прошедшее `BusMessage`, `api` MUST отбрасывать с предупреждением в лог, не прерывая работу. | MUST |
| REQ-001-7 | `orchestrator` MUST по запросу `api` поднимать по песочнице на агента через порт `SandboxProvider`. Шаблон окружения агента — только из конфигурации (`AGENT_TEMPLATE`), env — ровно набор из 4.7.1, метаданные — из 4.6.3. Docker-адаптер создаёт контейнер без монтирований, публикации портов и привилегий. | MUST |
| REQ-001-8 | `orchestrator` MUST дождаться `agent.started` от всех агентов роя и только после этого отправить задачу первому агенту сообщением от `user` и опубликовать `swarm.started`. Если не все стартовали за `AGENT_START_TIMEOUT_MS` — `swarm.failed` (`agent_start_timeout`) и уборка. | MUST |
| REQ-001-9 | `orchestrator` MUST завершать рой: по `agent.result` — `swarm.completed` с текстом результата; по команде «Стоп» — `swarm.stopped`; по истечении `SWARM_TIMEOUT_MS` от создания — `swarm.failed` (`swarm_timeout`). В каждом случае остановить и удалить все песочницы роя, опубликовать `agent.stopped` по каждому агенту, затем событие роя. | MUST |
| REQ-001-10 | `orchestrator` MUST при старте удалять все песочницы платформы (с метаданными `swag.kind`), оставшиеся от прошлого запуска: состояние оркестратора в памяти, и без этой уборки они бы висели. | MUST |
| REQ-001-11 | Агент MUST подписаться на свои входящие, опубликовать `agent.started` и на каждое сообщение выполнить «эстафету» из 4.7.2. | MUST |
| REQ-001-12 | UI MUST показывать список роёв, форму нового роя и страницу роя. На странице роя — граф (агенты со статусом, связи цепочки с числом сообщений), лента событий, результат или причина ошибки, кнопка «Стоп» для активного роя. Обновление — из WebSocket, без перезагрузки страницы. | MUST |
| REQ-001-13 | Логика UI (валидация формы, состояние роя из событий, переподключение потока) MUST быть в `packages/ui-core` по правилам ядра; Angular-компоненты только рисуют и передают действия. | MUST |
| REQ-001-14 | `npm run up` MUST собирать образ агента и поднимать `ui` вместе с остальными сервисами; `npm run infra:check` MUST проверять и `ui`. | MUST |
| REQ-001-15 | `arch:check` MUST проверять `packages/contracts` теми же правилами импортов, что ядра (из N-3). | MUST |
| REQ-001-16 | Dockerfile сервисов SHOULD не перечислять `package.json` каждого пакета вручную: новый пакет не требует правки Dockerfile (из N-1). | SHOULD |
| REQ-001-17 | Агент SHOULD завершаться с кодом 0 по `SIGTERM`, закрыв соединение с NATS. | SHOULD |
| REQ-001-18 | Белый список зависимостей ядер MUST расшириться пакетом `@swag/api-integration` (Q-5): `zod`, `@swag/contracts`, `@swag/api-integration`. Сам `api-integration` MUST подчиняться правилам ядра из 000 4.2 и зависеть только от `zod` и `@swag/contracts`; `arch:check` проверяет его как ядро. | MUST |

## 4. Контракты

### 4.1. Рой и агенты — `packages/contracts/src/swarm.ts`

```ts
export const AgentId = z.string().regex(/^agent-[1-9][0-9]?$/); // agent-1 … agent-99, назначает api по порядку
export const SwarmId = z.uuid();

export const AgentDraft = z.strictObject({
  name: z.string().trim().min(1).max(40),
  role: z.string().trim().min(1).max(500), // роль агента: текст обязанностей, не путать с ролью пользователя
});

export const SwarmCreateRequest = z.strictObject({
  task: z.string().trim().min(1).max(4000),
  agents: z.array(AgentDraft).min(1).max(8),
});

export const AgentSpec = AgentDraft.extend({ id: AgentId });

export const SwarmStatus = z.enum(['starting', 'running', 'completed', 'stopped', 'failed']);
export const AgentStatus = z.enum(['starting', 'idle', 'working', 'done', 'stopped', 'failed']);

// api → orchestrator
export const SwarmLaunch = z.strictObject({
  swarmId: SwarmId,
  task: z.string(),
  agents: z.array(AgentSpec).min(1),
});
```

Лимиты `max(4000)`, `max(500)`, `max(40)`, `max(8)` — предложение, решается в Q-3.

### 4.2. Шина — `packages/contracts/src/bus.ts`

Core NATS без JetStream. Subjects:

| Subject | Кто публикует | Кто слушает | Тело |
|---|---|---|---|
| `swarm.<swarmId>.agent.<agentId>.inbox` | оркестратор (от `user`), агенты | агент-адресат; `api` (`swarm.*.agent.*.inbox`) | `BusMessage` |
| `swarm.<swarmId>.events` | оркестратор, агенты | `api` (`swarm.*.events`); оркестратор | `PlatformEventInput` |

```ts
export const inboxSubject = (swarmId: string, agentId: string) => `swarm.${swarmId}.agent.${agentId}.inbox`;
export const eventsSubject = (swarmId: string) => `swarm.${swarmId}.events`;
export const ALL_INBOXES = 'swarm.*.agent.*.inbox';
export const ALL_EVENTS = 'swarm.*.events';

export const BusMessage = z.strictObject({
  id: z.uuid(),
  swarmId: SwarmId,
  from: z.union([AgentId, z.literal('user')]),
  to: AgentId,
  text: z.string(),
  ts: z.iso.datetime(),
});
```

Тела — JSON в UTF-8.

### 4.3. События — `packages/contracts/src/events.ts`

Конверт одинаковый для всех событий; `type` и `data` — дискриминированное объединение.

```ts
const Envelope = {
  id: z.uuid(),                       // назначает публикующий
  swarmId: SwarmId,
  ts: z.iso.datetime(),               // время публикующего
  source: z.enum(['api', 'orchestrator', 'agent']),
  agentId: AgentId.nullable(),        // null — событие роя
};

export const PlatformEventInput = z.discriminatedUnion('type', [
  z.strictObject({ ...Envelope, type: z.literal('swarm.created'),   data: z.strictObject({ task: z.string(), agents: z.array(AgentSpec) }) }),
  z.strictObject({ ...Envelope, type: z.literal('swarm.started'),   data: z.strictObject({}) }),
  z.strictObject({ ...Envelope, type: z.literal('swarm.completed'), data: z.strictObject({ result: z.string() }) }),
  z.strictObject({ ...Envelope, type: z.literal('swarm.stopped'),   data: z.strictObject({ reason: z.literal('user') }) }),
  z.strictObject({ ...Envelope, type: z.literal('swarm.failed'),    data: z.strictObject({
      reason: z.enum(['agent_start_timeout', 'swarm_timeout', 'orchestrator_unavailable', 'sandbox_error']),
      detail: z.string().optional() }) }),
  z.strictObject({ ...Envelope, type: z.literal('agent.launched'),  data: z.strictObject({ sandboxId: z.string() }) }),
  z.strictObject({ ...Envelope, type: z.literal('agent.started'),   data: z.strictObject({}) }),
  z.strictObject({ ...Envelope, type: z.literal('agent.working'),   data: z.strictObject({ messageId: z.uuid() }) }),
  z.strictObject({ ...Envelope, type: z.literal('agent.result'),    data: z.strictObject({ text: z.string() }) }),
  z.strictObject({ ...Envelope, type: z.literal('agent.stopped'),   data: z.strictObject({}) }),
  z.strictObject({ ...Envelope, type: z.literal('agent.failed'),    data: z.strictObject({ reason: z.string() }) }),
  z.strictObject({ ...Envelope, type: z.literal('bus.message'),     data: z.strictObject({
      messageId: z.uuid(), from: z.union([AgentId, z.literal('user')]), to: AgentId, text: z.string() }) }),
]);

// хранится и отдаётся api: + сквозной номер внутри роя
export type PlatformEvent = PlatformEventInput & { seq: number }; // seq ≥ 1, без пропусков
```

| Событие | Источник | `agentId` |
|---|---|---|
| `swarm.created` | `api` | `null` |
| `swarm.started`, `swarm.completed`, `swarm.stopped` | `orchestrator` | `null` |
| `swarm.failed` | `orchestrator`; `api` — только `orchestrator_unavailable` | `null` |
| `agent.launched`, `agent.stopped`, `agent.failed` | `orchestrator` | агент |
| `agent.started`, `agent.working`, `agent.result` | `agent` | агент |
| `bus.message` | `api` — из перехваченного `BusMessage` | `from`, если это агент, иначе `null` |

### 4.4. Проекция роя

Состояние роя для API и UI вычисляется из его событий одной чистой функцией. Она живёт в `packages/api-integration/src/swarm-view.ts` (Q-5): одна реализация для `api-core` и `ui-core`.

```ts
export interface SwarmView {
  id: string;
  task: string;
  status: SwarmStatus;
  createdAt: string;                  // ts события swarm.created
  agents: { id: AgentId; name: string; role: string; status: AgentStatus; messagesIn: number; messagesOut: number }[];
  edges: { from: AgentId; to: AgentId; messages: number }[]; // цепочка agent-1 → agent-2 → …
  result: string | null;
  failure: { reason: string; detail?: string } | null;
  lastSeq: number;
}
export function applyEvent(view: SwarmView | null, event: PlatformEvent): SwarmView;
export function projectSwarm(events: PlatformEvent[]): SwarmView; // = events.reduce(applyEvent, null)
```

Правила:

| Событие | Рой | Агент |
|---|---|---|
| `swarm.created` | создаётся, `starting`; агенты из `data.agents`, все `starting`; рёбра цепочки с `messages: 0` | — |
| `swarm.started` | `running` | — |
| `agent.started` | — | `idle` |
| `agent.working` | — | `working` |
| `bus.message` | `to` — `messagesIn + 1`; если `from` — агент: его `messagesOut + 1`, статус `idle`, ребро `from → to` — `messages + 1` | — |
| `agent.result` | — | `done` |
| `agent.stopped` | — | `stopped`, если не `done` и не `failed` |
| `agent.failed` | — | `failed` |
| `swarm.completed` | `completed`, `result = data.result` | — |
| `swarm.stopped` | `stopped` | — |
| `swarm.failed` | `failed`, `failure = data` | — |

`lastSeq` = `seq` последнего применённого события. Событие с `seq` не больше `lastSeq` игнорируется. Событие до `swarm.created` — ошибка.

### 4.5. `api`

Порт `API_PORT`, публикуется только на `127.0.0.1`. Входа нет: один локальный пользователь до спеки 012.

#### 4.5.1. REST

| Метод и путь | Тело | Ответ |
|---|---|---|
| `POST /swarms` | `SwarmCreateRequest` | `201 SwarmView`; `400 validation_error`; `409 too_many_active_swarms` |
| `GET /swarms` | — | `200 SwarmSummary[]`, новые первыми |
| `GET /swarms/:id` | — | `200 SwarmView`; `404 not_found` |
| `GET /swarms/:id/events?after=<seq>` | — | `200 PlatformEvent[]` с `seq > after` (по умолчанию `after=0`); `404` |
| `POST /swarms/:id/stop` | — | `202`; `404`; `409 swarm_finished` (рой в `completed`, `stopped`, `failed`) |
| `GET /health` | — | как в 000 |

```ts
export const SwarmSummary = z.object({
  id: SwarmId, task: z.string(), status: SwarmStatus, agentCount: z.number().int(), createdAt: z.iso.datetime(),
});
```

`POST /swarms`:
1. Проверить тело и число активных роёв (`starting` + `running`) против `MAX_ACTIVE_SWARMS`.
2. Назначить `swarmId` (UUID v4), агентам — `agent-1…agent-N` по порядку.
3. Записать `swarm.created`.
4. Вызвать оркестратор (`SwarmLaunch`).
5. Если оркестратор недоступен или ответил не `202` — записать `swarm.failed` (`orchestrator_unavailable`, `detail` — текст ошибки). Ответ всё равно `201`: рой создан, его статус виден в `SwarmView`.

#### 4.5.2. WebSocket

`GET /swarms/:id/stream?after=<seq>` с апгрейдом до WebSocket (`@fastify/websocket`). Сервер шлёт каждое событие роя с `seq > after` отдельным текстовым кадром JSON `PlatformEvent`, по возрастанию `seq`, затем новые события по мере поступления. Неизвестный рой — закрытие с кодом `4404`. Клиент ничего не шлёт. При разрыве UI переподключается с `after = lastSeq`.

#### 4.5.3. Ошибки

```json
{ "error": { "code": "validation_error", "message": "…", "issues": [{ "path": "agents.0.role", "message": "…" }] } }
```

Коды: `validation_error` (400), `not_found` (404), `too_many_active_swarms` (409), `swarm_finished` (409). `issues` — только у `validation_error`.

#### 4.5.4. Ядро `api-core`

```ts
export interface ApiCoreDeps {
  version: string;
  store: SwarmStore;                  // порт; в 001 — адаптер в памяти
  orchestrator: OrchestratorClient;   // порт; адаптер — HTTP
  clock: Clock;                       // { now(): string }  ISO
  ids: IdGenerator;                   // { uuid(): string }
  log: Logger;                        // { warn(msg, ctx?) }
  limits: { maxActiveSwarms: number };
}
export interface SwarmStore {
  appendEvent(event: PlatformEvent): void;            // seq уже назначен ядром
  events(swarmId: string, afterSeq: number): PlatformEvent[];
  view(swarmId: string): SwarmView | null;
  views(): SwarmView[];
}
export interface OrchestratorClient {
  launch(launch: SwarmLaunch): Promise<void>;          // ошибка = недоступен или не 202
  stop(swarmId: string): Promise<void>;
}
export interface ApiCore {
  info(): ServiceInfo;
  createSwarm(body: unknown): Promise<Result<SwarmView>>;
  listSwarms(): SwarmSummary[];
  getSwarm(id: string): Result<SwarmView>;
  getEvents(id: string, after: number): Result<PlatformEvent[]>;
  stopSwarm(id: string): Promise<Result<void>>;
  ingestEvent(raw: unknown): void;                     // из swarm.*.events
  ingestMessage(raw: unknown): void;                   // из swarm.*.agent.*.inbox → bus.message
  subscribe(swarmId: string, after: number, listener: (e: PlatformEvent) => void): Result<() => void>; // отписка
}
type Result<T> = { ok: true; value: T } | { ok: false; error: { code: string; message: string; issues?: { path: string; message: string }[] } };
```

Порты `Clock`, `IdGenerator`, `Logger` объявляются в каждом ядре, которому они нужны, а не в `contracts`.

### 4.6. `orchestrator`

#### 4.6.1. HTTP (вызывает только `api`)

| Метод и путь | Тело | Ответ |
|---|---|---|
| `POST /swarms` | `SwarmLaunch` (строгая схема: лишнее поле, например `image`, → 400) | `202`; `400 validation_error`; `409` — рой с таким id уже есть |
| `POST /swarms/:id/stop` | — | `202` (повторный вызов для остановленного роя — тоже `202`); `404` |
| `GET /health` | — | как в 000 |

Порт `ORCHESTRATOR_PORT` наружу не публикуется: `api` обращается по сети compose. Транспорт — по Q-6.

#### 4.6.2. Ядро `orchestrator-core`

```ts
export interface OrchestratorCoreDeps {
  version: string;
  sandboxes: SandboxProvider;
  bus: OrchestratorBus;
  clock: Clock;
  timers: Timers;                    // { setTimeout(fn, ms): TimerId; clearTimeout(id) } — порт, чтобы тесты управляли временем
  ids: IdGenerator;
  log: Logger;
  agent: { template: string; stepDelayMs: number };   // как песочница попадает в сеть и к NATS — дело адаптера
  timeouts: { agentStartMs: number; swarmMs: number };
}
export interface SandboxSpec {
  template: string;                 // окружение агента в терминах провайдера: тег образа Docker, rootfs microVM, шаблон E2B
  env: Record<string, string>;      // 4.7.1 без NATS_URL — его добавляет адаптер
  metadata: Record<string, string>; // ключ-значение для поиска песочниц роя и сирот
}
export interface SandboxProvider {
  create(spec: SandboxSpec): Promise<{ sandboxId: string }>; // создаёт и запускает
  remove(sandboxId: string): Promise<void>;                    // остановить и удалить; нет такой — не ошибка
  list(match: Record<string, string | true>): Promise<string[]>; // id песочниц; true — ключ есть с любым значением
}
export interface OrchestratorBus {
  publishEvent(event: PlatformEventInput): Promise<void>;
  publishMessage(message: BusMessage): Promise<void>;
  // подписку на swarm.*.events оболочка делает сама и передаёт события в core.handleEvent
}
export interface OrchestratorCore {
  info(): ServiceInfo;
  launch(body: unknown): Promise<Result<void>>;
  stop(swarmId: string): Promise<Result<void>>;
  handleEvent(raw: unknown): Promise<void>;   // реагирует на agent.started и agent.result
  cleanupOrphans(): Promise<number>;          // число удалённых песочниц
}
```

Порядок запуска роя:
1. `launch`.
2. Для каждого агента `create` → `agent.launched`. Ошибка `create` → `swarm.failed` (`sandbox_error`) и уборка.
3. Ждать `agent.started` от всех, но не дольше `agentStartMs`.
4. `BusMessage` от `user` к `agent-1` с текстом задачи.
5. `swarm.started`.

Таймер `swarmMs` отсчитывается от `launch`.

Уборка роя: `remove` всех песочниц роя → `agent.stopped` по каждому агенту → событие роя (`swarm.completed` / `swarm.stopped` / `swarm.failed`) → снять таймеры. После уборки рой помнится как завершённый: повторный `stop` — `202` без действий.

#### 4.6.3. Песочница агента

Порт `SandboxProvider` не зависит ни от технологии, ни от того, что в песочнице выполняется:
- Docker — первый адаптер, microVM (Firecracker) и E2B — следующие за тем же портом (роадмап, этап 15);
- агент — только один вид нагрузки (`swag.kind=agent`). Позже в песочнице выполняется любая работа: скрипт, сборка, тесты, инструмент агента (роадмап, раздел 2). Поэтому в порте нет ничего про агентов: что запустить, задают шаблон и env.

Всё, что относится к агенту — `AGENT_TEMPLATE`, env 4.7.1, ожидание `agent.started`, — живёт в `orchestrator-core` над портом.

`SandboxSpec` от ядра:
- `template` — `AGENT_TEMPLATE`; поля шаблона или образа в API нет;
- `env` — ровно 4.7.1 без `NATS_URL`;
- `metadata`: `swag.kind=agent`, `swag.swarm=<swarmId>`, `swag.agent=<agentId>`. Ключ `swag.kind` есть у каждой песочницы платформы.

`cleanupOrphans` при старте оболочки: `list({ 'swag.kind': true })` → `remove` каждой.

Docker-адаптер (`packages/adapter-docker`) переводит это в контейнер:
- `template` → образ; `metadata` → метки контейнера;
- `env` + `NATS_URL` из своей конфигурации (`DOCKER_AGENT_NATS_URL`);
- сеть — `DOCKER_AGENT_NETWORK` (сеть compose, чтобы был доступен NATS);
- без bind- и volume-монтирований, без публикации портов, без `Privileged`, пользователь из образа (`node`). Ограничения ресурсов и рантайм — спека 005.

### 4.7. `agent`

#### 4.7.1. Env агента (передаёт оркестратор)

| Переменная | Пример | Назначение |
|---|---|---|
| `NATS_URL` | `nats://nats:4222` | шина; добавляет адаптер провайдера, а не ядро |
| `SWARM_ID` | UUID | рой |
| `AGENT_ID` | `agent-2` | свой id |
| `AGENT_NAME` | `Редактор` | имя из запроса |
| `AGENT_ROLE` | `Проверяет текст на ошибки` | роль из запроса |
| `AGENT_NEXT` | `agent-3` или пусто | следующий в цепочке; пусто — последний |
| `AGENT_STEP_DELAY_MS` | `1000` | пауза перед ответом, чтобы шаги были видны в UI |

Схема — `AgentConfig` в `@swag/config`.

#### 4.7.2. Эстафета (`agent-core`)

1. При старте подписаться на свой inbox, затем опубликовать `agent.started`.
2. На каждое `BusMessage`:
   1. опубликовать `agent.working` (`messageId` = id сообщения);
   2. подождать `AGENT_STEP_DELAY_MS` (через порт таймера);
   3. вычислить `out = message.text + '\n' + AGENT_NAME + ' (' + AGENT_ROLE + '): ok'`;
   4. если `AGENT_NEXT` задан — опубликовать `BusMessage` от себя к `AGENT_NEXT` с текстом `out`, иначе опубликовать `agent.result` с `text = out`.
3. Сообщения обрабатываются по одному, в порядке поступления.

Пример: задача `T`, агенты `A (r1)`, `B (r2)` → результат роя `T\nA (r1): ok\nB (r2): ok`.

### 4.8. UI

- `apps/ui/cabinet` (пакет `@swag/cabinet`) — Angular, версия — последняя стабильная на момент реализации (записать в журнал). Компоненты только рисуют `ui-core` и передают действия.
- `packages/ui-core` — ядро по правилам 000 4.2. Порты:
  - `SwarmsApi` — REST из 4.5.1;
  - `EventStream` — открыть поток роя с `after`, получить события, закрыть.

  Операции: валидация формы схемой `SwarmCreateRequest`; создание роя; список; состояние страницы роя через `applyEvent`; переподключение потока с `after = lastSeq` и паузой 1 с между попытками; остановка.
- Адреса: UI ходит в API относительным путём `/api/...` (REST и WebSocket), прокси снимает префикс `/api` и отправляет в `api`. Как отдаётся UI — Q-4.
- Экраны:
  - `/` — список роёв: задача, статус, число агентов, время; кнопка «Новый рой»;
  - `/swarms/new` — форма: задача; агенты — имя и роль, добавить и удалить, порядок сверху вниз = порядок цепочки; «Запустить» → переход на страницу роя;
  - `/swarms/:id` — граф: узлы-агенты в порядке цепочки, цвет по статусу, на рёбрах число сообщений; лента событий с текстом сообщений; результат или причина ошибки; «Стоп», пока рой `starting` или `running`.
- Граф рисуется своим SVG-компонентом, без библиотеки (Q-4).
- Пользовательский текст (задача, роли, сообщения) выводится только интерполяцией Angular, без `innerHTML`.

### 4.9. Переменные окружения

| Переменная | Сервис | Пример в `.env.example` | Назначение |
|---|---|---|---|
| `ORCHESTRATOR_URL` | `api` | `http://orchestrator:3001` | адрес оркестратора |
| `MAX_ACTIVE_SWARMS` | `api` | `3` | лимит одновременно активных роёв |
| `AGENT_TEMPLATE` | `orchestrator` | `swag-agent:dev` | окружение агента для провайдера песочниц; для Docker — тег образа |
| `DOCKER_AGENT_NETWORK` | `orchestrator` (Docker-адаптер) | `swag_default` | сеть compose для контейнеров агентов |
| `DOCKER_AGENT_NATS_URL` | `orchestrator` (Docker-адаптер) | `nats://nats:4222` | адрес NATS изнутри контейнера агента |
| `AGENT_STEP_DELAY_MS` | `orchestrator` → агент | `1000` | пауза эстафеты |
| `AGENT_START_TIMEOUT_MS` | `orchestrator` | `30000` | ожидание `agent.started` от всех |
| `SWARM_TIMEOUT_MS` | `orchestrator` | `300000` | предельное время роя |
| `UI_PORT` | `ui` | `4200` | порт UI на `127.0.0.1` |

Схемы: `ApiConfig` и `OrchestratorConfig` расширяются, `AgentConfig` — новая, без `BaseConfig`: агенту не нужен `DATABASE_URL`. Значения лимитов и таймаутов — Q-3.

### 4.10. Пакеты

| Пакет | Что | Зависимости |
|---|---|---|
| `packages/adapter-docker` | `SandboxProvider` на dockerode; своя конфигурация `DOCKER_AGENT_NETWORK`, `DOCKER_AGENT_NATS_URL` | `dockerode`, `@swag/orchestrator-core` (типы порта) |
| `packages/adapter-nats` | публикация и подписка JSON по subjects 4.2 для `api`, `orchestrator`, `agent` | `@nats-io/transport-node`, `@swag/contracts` |
| `packages/api-integration` | общая чистая логика для ядер, работающих с API платформы: проекция роя 4.4; правила ядра | `zod`, `@swag/contracts` |
| `packages/adapter-memory` | `SwarmStore` в памяти (хранит события и `SwarmView` через `applyEvent`) | `@swag/api-core` (типы), `@swag/contracts`, `@swag/api-integration` |
| `packages/adapter-orchestrator-http` | `OrchestratorClient` через `fetch` | `@swag/api-core` (типы), `@swag/contracts` |
| `packages/ui-core` | ядро UI | `zod`, `@swag/contracts`, `@swag/api-integration` |
| `apps/ui/cabinet` | личный кабинет на Angular, пакет `@swag/cabinet`; npm workspaces дополняются `apps/ui/*` | `@swag/ui-core`, Angular |

Адаптеры зависят от ядра только ради типов порта (`import type`). Порты в ядрах и адаптеры для тестов в памяти (фейковый `SandboxProvider`, шина в памяти, ручные таймеры) — в `test/` соответствующих пакетов или в общем тестовом пакете, на выбор агента с записью в журнал.

## 5. Критерии приёмки

- **AC-001-1** — *Given* `SwarmCreateRequest`, *When* разбор, *Then* валидный запрос с 1 и с 8 агентами проходит; пустая задача, 0 или 9 агентов, роль длиннее 500, лишнее поле — ошибка с путём поля.
- **AC-001-2** — *Given* последовательность событий из таблицы 4.4, *When* `projectSwarm`, *Then* статусы роя и агентов, счётчики сообщений, рёбра, `result` и `failure` соответствуют таблице; событие с повторным `seq` не меняет состояние.
- **AC-001-3** — *Given* `api` с фейковым оркестратором, *When* `POST /swarms` с тремя агентами, *Then*:
  - ответ `201`, `status: starting`, агенты `agent-1…agent-3`;
  - оркестратор получил `SwarmLaunch` с тем же `swarmId`;
  - у роя одно событие `swarm.created` с `seq: 1`.
- **AC-001-4** — *Given* `api`, *When* `POST /swarms` с невалидным телом, *Then* `400`, `error.code = validation_error`, в `issues` путь поля.
- **AC-001-5** — *Given* `MAX_ACTIVE_SWARMS=1` и один рой в `running`, *When* `POST /swarms`, *Then* `409 too_many_active_swarms`; после `swarm.completed` первого роя новый создаётся.
- **AC-001-6** — *Given* оркестратор отвечает ошибкой, *When* `POST /swarms`, *Then* `201`, а `GET /swarms/:id` — `status: failed`, `failure.reason = orchestrator_unavailable`.
- **AC-001-7** — *Given* рой в `api`, *When* `ingestEvent` получает события агентов и оркестратора, а `ingestMessage` — `BusMessage`, *Then*:
  - события сохранены с `seq` 2, 3, … без пропусков;
  - сообщение превращено в `bus.message` с теми же `from`, `to`, `text`;
  - `GET /swarms/:id/events?after=1` отдаёт все события, кроме первого.
- **AC-001-8** — *Given* невалидное событие или сообщение, или событие неизвестного роя, *When* `ingestEvent` / `ingestMessage`, *Then* ничего не сохраняется, в лог уходит предупреждение, следующее валидное событие обрабатывается.
- **AC-001-9** — *Given* рой с 5 событиями, *When* клиент WebSocket подключается с `after=2`, затем приходят ещё 2 события, *Then* клиент получает `seq` 3, 4, 5, 6, 7 по порядку, без повторов; подключение к неизвестному рою закрывается с кодом `4404`. (Тест — настоящий WebSocket к Fastify на случайном порту, без Docker.)
- **AC-001-10** — *Given* рой в `running`, *When* `POST /swarms/:id/stop`, *Then* `202` и вызван `stop` оркестратора; для роя в `completed` — `409 swarm_finished`; для неизвестного — `404`.
- **AC-001-11** — *Given* `orchestrator-core` с фейковым `SandboxProvider`, *When* `launch` с тремя агентами, *Then*:
  - создано 3 песочницы с `template = AGENT_TEMPLATE` и метаданными `swag.kind=agent`, `swag.swarm`, `swag.agent`;
  - у каждой env с ровно теми ключами, что в 4.7.1, кроме `NATS_URL`, и `AGENT_NEXT` по цепочке, у последней — пусто;
  - опубликовано 3 `agent.launched`.
- **AC-001-12** — *Given* `orchestrator` по HTTP, *When* `POST /swarms` с лишним полем `image`, *Then* `400`, песочницы не создаются.
- **AC-001-13** — *Given* запущенный рой, *When* приходят `agent.started` от двух агентов из трёх, *Then* задача не отправлена; *When* приходит третий, *Then* опубликовано `BusMessage` от `user` к `agent-1` с текстом задачи, затем `swarm.started`.
- **AC-001-14** — *Given* рой, где один агент не прислал `agent.started`, *When* время (ручные таймеры) уходит за `agentStartMs`, *Then* все песочницы роя удалены, `agent.stopped` по каждому агенту, `swarm.failed` с `agent_start_timeout`.
- **AC-001-15** — *Given* рой в `running`, *When* `agent.result` от последнего агента, *Then* все песочницы удалены, `agent.stopped` по каждому агенту, затем `swarm.completed` с `result` из `agent.result`.
- **AC-001-16** — *Given* рой в `running`, *When* `stop`, *Then* песочницы удалены, `agent.stopped` по каждому агенту, `swarm.stopped` с `reason: user`; повторный `stop` — успех без новых событий; `stop` неизвестного роя — `not_found`.
- **AC-001-17** — *Given* рой в `running`, *When* время уходит за `swarmMs`, *Then* уборка и `swarm.failed` с `swarm_timeout`.
- **AC-001-18** — *Given* фейковый провайдер с двумя песочницами с метаданными `swag.kind` и одной без них, *When* `cleanupOrphans`, *Then* обе удалены, третья осталась, результат `2`.
- **AC-001-19** — *Given* `agent-core` агента `agent-1` с `AGENT_NEXT=agent-2`, *When* старт и сообщение `T`, *Then* по порядку `agent.started`, `agent.working`, затем `BusMessage` к `agent-2` с текстом из 4.7.2; у последнего агента вместо сообщения — `agent.result` с тем же текстом.
- **AC-001-20** — *Given* `api-core`, `orchestrator-core` и три `agent-core` в одном процессе: шина в памяти, фейковый провайдер, который на `create` поднимает `agent-core`, `AGENT_STEP_DELAY_MS=0`, *When* `createSwarm` с задачей `T` и агентами `A (r1)`, `B (r2)`, `C (r3)`, *Then*:
  - `GET` роя даёт `status: completed`, `result = "T\nA (r1): ok\nB (r2): ok\nC (r3): ok"`;
  - все агенты `stopped` или `done`, на каждом ребре по 1 сообщению;
  - песочниц у провайдера 0;
  - `seq` событий непрерывны.

  Это сквозной тест без Docker и сети.
- **AC-001-21** — *Given* NATS (в CI — сервис workflow, локально — compose), *When* адаптер шины публикует `BusMessage` и событие и подписан на `ALL_INBOXES` и `ALL_EVENTS`, *Then* получает их неизменёнными; невалидный JSON на subject не ломает подписку.
- **AC-001-22** — *Given* Docker, *When* `adapter-docker` создаёт песочницу из маленького образа с метаданными, `list` по ним (по значению и по `true`), `remove`, *Then* `list` находит её, после `remove` — пусто; у созданного контейнера метки равны метаданным, в env есть `NATS_URL` из конфигурации адаптера, сеть — `DOCKER_AGENT_NETWORK`, нет монтирований, опубликованных портов и `Privileged`. В CI тест обязателен; локально без Docker пропускается с сообщением.
- **AC-001-23** — *Given* `ui-core` с фейковыми портами, *When*:
  - форма с пустой задачей — ошибка;
  - валидная форма — вызван `SwarmsApi.create`;
  - поток отдаёт события — состояние страницы совпадает с `projectSwarm`;
  - поток рвётся — переподключение с `after = lastSeq`, без повторов в ленте.

  *Then* каждое из этих условий выполняется.
- **AC-001-24** — *Given* фикстура `contracts` или `api-integration` с `import { readFile } from 'node:fs'`, *When* `arch:check`, *Then* выход 1 с файлом, строкой и спецификатором (из N-3); фикстура ядра с импортом `@swag/api-integration` — выход 0; фикстура `api-integration` с зависимостью на ядро (`@swag/api-core`) — выход 1.
- **AC-001-25** `[manual]` — *Given* Docker и `.env` из `.env.example`, *When* `npm run up`, затем `npm run infra:check`, *Then*:
  - образ `swag-agent:dev` собран;
  - `postgres`, `nats`, `api`, `orchestrator`, `ui` healthy;
  - `infra:check` проверяет `ui` и выходит с кодом 0.

  Проверка: вывод в журнал.
- **AC-001-26** `[manual]` — *Given* поднятая система, *When* в UI создать рой из трёх агентов с ролями и запустить, *Then*:
  - статусы агентов в графе меняются по ходу эстафеты без перезагрузки страницы;
  - в ленте видны сообщения;
  - после завершения показан результат по 4.7.2;
  - `docker ps -a --filter label=swag.kind` пуст.

  Проверка: шаги, скриншоты графа в начале и в конце, вывод `docker ps` — в журнал.
- **AC-001-27** `[manual]` — *Given* рой с `AGENT_STEP_DELAY_MS=5000` в процессе, *When* «Стоп» в UI, *Then* рой `stopped`, все агенты `stopped`, контейнеров с меткой нет. Перезапуск `orchestrator` при живом рое — после старта контейнеров с меткой нет (REQ-001-10). Проверка: вывод в журнал.

## 6. Нефункциональные требования

| ID | Требование | Как измеряется |
|---|---|---|
| NFR-001-1 | Точка отсчёта без порога: время от `POST /swarms` до `swarm.started` для роя из 3 агентов (холодный запуск контейнеров, без пула). Сравним с тёплым пулом в 005 (цель роадмапа — < 2 с). | 10 прогонов, медиана и p95 по `ts` событий, таблица в журнале |
| NFR-001-2 | Точка отсчёта без порога: задержка от публикации события в NATS до получения кадра клиентом WebSocket. | 100 событий, медиана и p95, таблица в журнале |
| NFR-001-3 | `npm test` остаётся быстрее 60 с локально (без тестов, которым нужен Docker). | время команды |

## 7. Безопасность: что не должно сломаться

- Доступ к Docker есть только у `orchestrator` (по Q-1), ни у `api`, ни у агентов → ревью `compose.yaml`, AC-001-22.
- Оркестратор запускает только шаблон из конфигурации; шаблон или образ из запроса не принимается. Docker-адаптер создаёт контейнер без монтирований, портов и привилегий → AC-001-11, AC-001-12, AC-001-22.
- В env агента нет ничего, кроме 4.7.1: ни `DATABASE_URL`, ни учётных данных → AC-001-11.
- Контейнеры агентов не остаются после роя и после перезапуска оркестратора → AC-001-15…18, AC-001-26, AC-001-27.
- `api` и `ui` опубликованы только на `127.0.0.1`, `orchestrator` не опубликован → ревью `compose.yaml`. Входа нет, поэтому наружу система открываться не должна до спеки 012.
- Невалидные данные с шины не роняют `api` → AC-001-8, AC-001-21.
- Пользовательский текст в UI не исполняется как HTML → правило 4.8, пункт ревью.
- Известное ограничение 001, а не дефект: контейнеры агентов в общей сети compose видят Postgres, NATS и `api`. Сеть на рой — спека 005, изоляция шины — 007. Код агента в 001 — только эстафета.

## 8. Задачи для агента

Выполняются по порядку. После каждой задачи — коммит.

- [ ] **T-1.** Dockerfile `api`, `orchestrator`, `agent` без ручного списка `package.json` пакетов. Способ на выбор агента с записью в журнал: `COPY --parents` или другой, при котором новый пакет не требует правки Dockerfile. *(из N-1)* Закрывает: REQ-001-16. Готово, когда образы собираются, а добавление пустого пакета-фикстуры не требует правки Dockerfile — проверено и записано в журнал.
- [ ] **T-2.** `arch:check`: проверяет `packages/contracts` и `packages/api-integration` правилами ядра; белый список ядер — `zod`, `@swag/contracts`, `@swag/api-integration`; тесты на фикстурах. *(из N-3)* Закрывает: REQ-001-15, REQ-001-18, AC-001-24.
- [ ] **T-3.** Контракты 4.1–4.3 в `contracts`; пакет `packages/api-integration` с проекцией 4.4; тесты; README обоих пакетов. Закрывает: REQ-001-2 (схема), AC-001-1, AC-001-2.
- [ ] **T-4.** `packages/adapter-nats` и тест с настоящим NATS; сервис NATS в GitHub Actions. Закрывает: AC-001-21.
- [ ] **T-5.** `agent-core` (эстафета, порты шины и таймера) и оболочка `apps/agent`: `AgentConfig`, подписка, `SIGTERM`. Закрывает: REQ-001-11, REQ-001-17, AC-001-19.
- [ ] **T-6.** `orchestrator-core`: запуск, ожидание готовности, отправка задачи, завершение, остановка, таймауты, уборка, `cleanupOrphans`; тесты с фейковым провайдером, шиной в памяти и ручными таймерами. Закрывает: REQ-001-7…10, AC-001-11, AC-001-13…18.
- [ ] **T-7.** `packages/adapter-docker` и тест с настоящим Docker (обязателен в CI). Закрывает: AC-001-22.
- [ ] **T-8.** Оболочка `apps/orchestrator`:
  - HTTP 4.6.1 (по Q-6);
  - подписка на `swarm.*.events`;
  - `cleanupOrphans` при старте;
  - `OrchestratorConfig`;
  - доступ к Docker по Q-1.

  Закрывает: AC-001-12.
- [ ] **T-9.** `api-core`, `packages/adapter-memory`, `packages/adapter-orchestrator-http`. Закрывает: REQ-001-2…4, REQ-001-6, AC-001-3…8, AC-001-10.
- [ ] **T-10.** Оболочка `apps/api`:
  - REST 4.5.1 и WebSocket 4.5.2;
  - подписки на `ALL_EVENTS` и `ALL_INBOXES`;
  - `ApiConfig`.

  Закрывает: REQ-001-5, AC-001-9.
- [ ] **T-11.** Сквозной тест без Docker из AC-001-20; место теста — на выбор агента с записью в журнал. Закрывает: AC-001-20.
- [ ] **T-12.** `packages/ui-core`: порты, валидация формы, состояние роя, переподключение. Закрывает: REQ-001-13, AC-001-23.
- [ ] **T-13.** `apps/ui/cabinet` на Angular (workspaces `apps/ui/*`, README `apps/ui` и `apps/ui/cabinet`): три экрана из 4.8, SVG-граф, прокси `/api` (по Q-4). Закрывает: REQ-001-1, REQ-001-12.
- [ ] **T-14.** `compose.yaml`:
  - сервис `ui`;
  - сборка образа агента в `npm run up`;
  - переменные 4.9 в `.env.example`;
  - `infra:check` для `ui`;
  - `npm run dev` для новых сервисов.

  Закрывает: REQ-001-14.
- [ ] **T-15.** Ручные проверки и замеры: AC-001-25…27, NFR-001-1…3. Затем README: новые пакеты, правки `api`, `api-core`, `orchestrator`, `orchestrator-core`, `agent`, `agent-core`, `ui`, `config`, корневой README (новые команды и как открыть UI).

## 9. Открытые вопросы

- [x] **Q-1.** Как оркестратор получает доступ к Docker? *(Claude, 2026-10-21)*
  - **(а)** Смонтировать `/var/run/docker.sock` только в контейнер `orchestrator`. Ограничения задаются в Docker-адаптере: только образ из `AGENT_TEMPLATE`, без монтирований, портов и привилегий, метки на всём. Socket даёт права root на хосте, но код оркестратора наш, а система локальная. Усиление — в 005.
  - **(б)** Docker socket proxy (`tecnativa/docker-socket-proxy`) с открытыми только разделами контейнеров. Создание контейнера с bind-монтированием он всё равно пропустит, так что выигрыш небольшой при лишнем контейнере.
  - **(в)** Запускать `orchestrator` на хосте вне compose. Ломает правило «всё в Docker» и `npm run up` одной командой.

  **Рекомендация:** (а), с проверкой в 005, где песочницы усиливаются.
  **Ответ:** (а) — socket монтируется только в `orchestrator`, ограничения — в Docker-адаптере, усиление — в 005. Порт `SandboxProvider` не зависит от Docker и от вида нагрузки (4.6.3). *(человек, 2026-10-21)*
- [x] **Q-2.** Топология роя в 001. *(Claude, 2026-10-21)*
  - **(а)** Цепочка по порядку списка, сценарий «эстафета» из 4.7.2. Граф рисуется сам, циклов не бывает, результат проверяется точно.
  - **(б)** Пользователь рисует связи `edges` сам. Нужна проверка на циклы и правило, кто выдаёт результат, — это задача координатора и плана роя в 009.
  - **(в)** Широковещание всем. Неясно, кто завершает рой.

  **Рекомендация:** (а).
  **Ответ:** (а) — цепочка. *(человек, 2026-10-21)*
- [x] **Q-3.** Лимиты и таймауты — числа в 4.1 и 4.9, в роадмапе их нет. *(Claude, 2026-10-21)*
  Предлагаю:
  - до 8 агентов в рое;
  - до 3 активных роёв;
  - задача до 4000 символов, роль до 500, имя до 40;
  - пауза эстафеты 1 с;
  - старт агентов — до 30 с;
  - рой целиком — до 5 мин.

  Все, кроме длин полей, — env, их можно менять без правки кода.
  **Ответ:** принять как предложено. *(человек, 2026-10-21)*
- [x] **Q-4.** Как отдаётся UI в compose и чем рисовать граф? *(Claude, 2026-10-21)*
  - **(а)** Сервис `ui` запускает `ng serve` с прокси `/api` → `api` (REST и WebSocket) и перезагрузкой при правке. Только для разработки, но production-сборки в этапе 1 и нет.
  - **(б)** Сборка `ng build` и раздача nginx с тем же прокси: ближе к продакшену, но в разработке нужна пересборка или отдельный режим.

  Граф: своя SVG-цепочка из узлов и стрелок (до 8 агентов) или библиотека (ngx-graph, Cytoscape). Произвольный граф появится в 009.

  **Рекомендация:** (а) и своя SVG; библиотеку выбрать в 009.
  **Ответ:** (а) — `ng serve` с прокси и своя SVG. *(человек, 2026-10-21)*
- [x] **Q-5.** Где живёт проекция роя из событий (4.4)? *(Claude, 2026-10-21)*
  - **(а)** В `@swag/contracts` как чистые функции рядом со схемами. Одна реализация для `api-core` и `ui-core`. Это расширяет роль `contracts` с «схемы и типы» на «схемы и чистые функции над ними», и это нужно записать в `architecture.md`.
  - **(б)** Отдельный общий пакет-ядро, например `@swag/swarm-model`. Тогда его надо добавить в белый список ядер.
  - **(в)** Отдельно в `api-core` и `ui-core`. Две копии правил, которые разойдутся.

  **Рекомендация:** (а) — самое простое, `arch:check` после T-2 проверяет `contracts` как ядро.
  **Ответ:** отдельный общий пакет `@swag/api-integration` (`packages/api-integration`); добавляется в белый список ядер (REQ-001-18). *(человек, 2026-10-21)*
- [x] **Q-6.** Транспорт `api` → `orchestrator`. *(Claude, 2026-10-21)*
  - **(а)** HTTP (4.6.1). Явные коды ответов, тестируется через `inject`, адрес — `ORCHESTRATOR_URL`.
  - **(б)** NATS request-reply. На один адрес меньше, все сервисы общаются через шину, но ошибки и таймауты придётся описывать заново.

  **Рекомендация:** (а). Порт `OrchestratorClient` позволяет сменить транспорт позже, не трогая `api-core`.
  **Ответ:** (а) — HTTP. *(человек, 2026-10-21)*
- [ ] **Q-7.** Публикация порта оркестратора на хост: спеки 000 и 001 расходятся. *(Claude, 2026-10-22)*
  - **Противоречие.** 4.6.1 и раздел 7 этой спеки: `ORCHESTRATOR_PORT` наружу не публикуется, порт доступен только по сети compose. Спека 000, 4.7 (`infra:check`, done): проверка `/health` у `orchestrator` с хоста через `127.0.0.1`, а AC-000-11 требует, чтобы `infra:check` прошёл с кодом 0.
  - **(а)** Не публиковать порт (как в 001). Тогда `infra:check` проверяет `orchestrator` через `docker compose exec` внутри контейнера, и 000 4.7 меняется этой спекой.
  - **(б)** Оставить публикацию на `127.0.0.1` (как сейчас в `compose.yaml`) и поправить 001 4.6.1 и раздел 7: порт на localhost без входа — любой процесс на хосте может запустить рой.
  - **Рекомендация:** (а): публикация без входа нарушает смысл раздела 7 этой спеки; проверка через `exec` не зависит от портов.
  - В текущем коде выбран (б) как временный: `compose.yaml` публикует `127.0.0.1:${ORCHESTRATOR_PORT}`. Изменить после ответа.
  **Ответ:** *(ожидает человека)*

## 10. Журнал реализации

Заполняет агент.

| Дата | Ветка / коммит | Что сделано | Отклонения от спеки |
|---|---|---|---|
| 2026-10-22 | main | До начала реализации, по решению человека: UI — в `apps/ui/cabinet`; `apps/ui/` — папка независимо собираемых и деплоимых фронтендов (каркас, кабинет, админка организации, супервизор, лендинг). Каркас и микрофронтенды — 014. | Разделы 1, 2, 4.8, 4.10 и T-13 изменил человек |
| 2026-10-22 | `spec/001-walking-skeleton` / `a1d9920` | Статус `in-progress`, ветка от `main`. Реализация T-1…T-14 и проверки T-15 (Docker Desktop 29.9.2, `npm run up`, `infra:check`, сценарии через HTTP). Код: контракты и `api-integration` (T-3), `adapter-nats` (T-4), `agent-core` и `apps/agent` (T-5), `orchestrator-core` (T-6), `adapter-docker` (T-7), `apps/orchestrator` (T-8), `api-core`, `adapter-memory`, `adapter-orchestrator-http` (T-9), `apps/api` (T-10), сквозной тест (T-11), `ui-core` (T-12), `apps/ui/cabinet` на Angular 22.2.3 (T-13), compose и env (T-14). `npm run check` **не запускался** по указанию человека; проверялись `typecheck`, `arch:check`, `spec:check` и `vitest` по всему репозиторию (зелёные, кроме тестов с `NATS_TEST_URL`, которые пропущены локально). | См. строки ниже. |
| 2026-10-22 | — | **Зависимости (точные версии).** Node 24.20.0; `dockerode` 5.0.1 и `@types/dockerode` 4.0.2 (adapter-docker); `@nats-io/transport-node` 3.4.0 (adapter-nats, корень); `@fastify/websocket` 11.3.4 (apps/api); Angular 22.2.3 (`@angular/core`, `common`, `compiler`, `platform-browser`, `router`, `build`, `cli`), `rxjs` 7.8.2, `tslib` 2.8.1 (apps/ui/cabinet). `npm install` выдаёт 2 уязвимости (1 low, 1 high) в транзитивных пакетах Angular CLI, не исправлялись. | Отклонений нет. |
| 2026-10-22 | — | **Раскладка тестов.** Сквозной тест AC-001-20 — `apps/api/test/e2e.test.ts` (нужен api-core, orchestrator-core, agent-core, память; в `apps/api` это прямой тест оболочки-сборки). Тест WebSocket AC-001-9 — там же, `apps/api/test/api.test.ts`. | Место теста на выбор агента (T-11), записано. |
| 2026-10-22 | — | **Арх-проверка (T-2).** `arch:check` проверяет `packages/contracts` и `packages/api-integration` как ядра (список `KERNEL_EXTRA_PACKAGES`), белый список — `zod`, `@swag/contracts`, `@swag/api-integration`. | Трактовка 4.5 расширена по REQ-001-15/18. |
| 2026-10-22 | — | **Корневой `tsconfig.json`.** Теперь `include: []` и ссылки на все пакеты. Раньше он наследовал `include` из `tsconfig.dev.json` и тесты падали с TS2878 при импорте чужого `src`. | Техническая правка сборки. |
| 2026-10-22 | — | **AC-000-16 переименован.** Тесты `info()` ядер получили id AC-000-16 в имени; ядра теперь принимают порты, поэтому тесты строят их с фейками. | Контракт 000  4.2 не менялся. |
| 2026-10-22 | — | **Отклонения от 4.6.1 / раздел 7 — Q-7 (блокирует).** Порт оркестратора опубликован на `127.0.0.1` ради `infra:check` из 000. См. Q-7 в разделе 9. | Открыто. |
| 2026-10-22 | — | **Docker, `npm run up`.** Первый запуск: `orchestrator` падал с `EACCES /var/run/docker.sock` (пользователь `node` без группы сокета). Исправлено `group_add: ['0']` у сервиса `orchestrator` в `compose.yaml`. Файл `.env` уже содержал `CONTEXT7_API_KEY`; к нему дописаны значения из `.env.example`, ключ оставлен как был. Ключ попадает в контейнеры через `env_file: .env`: заметка для человека. | Отклонение от 001 4.6.3 (пользователь образа оркестратора): группа root для сокета. |
| 2026-10-22 | — | **AC-001-25 `[manual]`.** `npm run up` (сборка `swag-agent:dev`, `swag-api`, `swag-orchestrator`, `swag-ui`): `postgres`, `nats`, `orchestrator`, `api`, `ui` healthy. `npm run infra:check`: `ok postgres`, `ok nats`, `ok api`, `ok orchestrator`, `ok ui`, выход 0. Первый запуск сборки обрывался `failed to receive status: rpc error EOF` со стороны Docker Desktop: повторный запуск прошёл. | — |
| 2026-10-22 | — | **AC-001-26 `[manual]` — сценарий через HTTP, без UI.** Рой из трёх агентов `A (r1)`, `B (r2)`, `C (r3)` через `POST /swarms` на `127.0.0.1:3000`: статус `completed`, `result = "T\nA (r1): ok\nB (r2): ok\nC (r3): ok"`, 19 событий, `seq` 1…19 без пропусков, `docker ps -a --filter label=swag.kind` после роя пуст. **Не проверено:** граф и лента в браузере, скриншоты (нужен человек, UI в браузере не открывался). | Частично: UI не проверен. |
| 2026-10-22 | — | **AC-001-27 `[manual]`.** Стоп: `POST /swarms/:id/stop` → `202`, рой `stopped`, все агенты `stopped`, контейнеров с меткой 0 (сценарий `stop2.ps1`, `AGENT_STEP_DELAY_MS=1000`, не 5000). Перезапуск `orchestrator` при живом рое (`docker compose restart orchestrator`): до перезапуска 3 контейнера, после — 0 (REQ-001-10). Кнопка «Стоп» в UI не проверена. | Частично: UI-кнопка не проверена; задержка 1000 мс, не 5000. |
| 2026-10-22 | — | **AC-001-22 на настоящем Docker.** `npm test` `packages/adapter-docker`: проходит на Docker 29.9.2, образ `alpine:3.22`. **AC-001-21:** тест NATS пропущен локально (нет `NATS_TEST_URL`); в CI сервис `nats` задан в `ci.yml`, локально не запускался. | AC-001-21 не подтверждён локально. |
| 2026-10-22 | — | **NFR (не замерялись).** NFR-001-1 (время до `swarm.started`, 10 прогонов) и NFR-001-2 (задержка WebSocket, 100 событий) **не выполнены**: нужен отдельный прогон. NFR-001-3: `npm test` (vitest по `packages`, `apps`, `scripts`) — около 5 с, при исключении `.claude/**`. | NFR-001-1, NFR-001-2 не сделаны. |
| 2026-10-22 | — | **Наблюдение (не в спеке).** Vitest по умолчанию подхватывает тесты из `.claude/worktrees/*` (чужие worktree), поэтому `npm test` в основном чекауте дублирует тесты. В работе запускался с `--exclude ".claude/**"`. Заметка на будущее. | N-кандидат, не записан в `notes.md`. |
| 2026-10-22 | — | **UI в браузере (проверил человек с Claude).** Кабинет в compose не грузился: в образ попадал локальный кэш `apps/ui/cabinet/.angular` (504 Outdated Optimize Dep), каталог кабинета принадлежал root (EACCES у `ng serve` под `node`), не копировался `tsconfig.base.json`; без `<base href="/">` прямой переход на `/swarms/...` давал 404 на `main.js`. Исправлено: `**/.angular` в `.dockerignore`, `chown` каталога и копия `tsconfig.base.json` в Dockerfile, `<base href>` в `index.html`. После исправления AC-001-26: рой из трёх агентов из UI, статусы в графе и лента обновляются без перезагрузки, результат по 4.7.2, контейнеров с меткой 0. AC-001-27: «Стоп» в UI во время эстафеты (задержка 1000 мс) — рой и агенты `stopped`, контейнеров 0. Healthcheck `ui` проверяет только отдачу `index.html` и сломанный UI не ловит. | Задержка 1000 мс, не 5000. |
| 2026-10-22 | — | **Ручной UI.** Angular 22 собирается (`ng build`, bundle 689 kB raw). Ручная проверка графа и кнопки «Стоп» в браузере — не проведена. | Не проверено, нужен человек. |
