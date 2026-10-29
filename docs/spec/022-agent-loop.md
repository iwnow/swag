---
id: "022"
title: Агентный цикл
status: in-progress
roadmap_stage: 2
depends_on: ["001", "002", "016"]
superseded_by: null
updated: 2026-10-29
---

# 022. Агентный цикл

> **Коротко.** Агенты роя начинают думать: эстафета без модели из 001 заменяется агентным циклом, который вызывает модель через LLM Gateway.
> - **Что появится.**
>   - Агентный цикл `runAgentLoop` в `agent-core`: вызов модели → вызовы инструментов → результаты, все 4 вида ответа модели. Цикл не знает о рое: на вход — контекст вызова (модель, системный промпт, история, инструменты, лимиты), на выход — шаги и итог. Тот же цикл потом работает в чат-боте (018).
>   - Агент роя поверх цикла: системный промпт из имени и роли, инструменты `send_message` («написать агенту») и `finish` («завершить», только у агента, которому пришла задача).
>   - Адаптер `packages/adapter-openai`: порт модели `ChatModel` на OpenAI SDK, ходит только в `llm-gateway`.
>   - В форме роя у агента выбирается модель `chat-small` или `chat-large`. В ленте UI — шаги агентов и вызовы модели с токенами и стоимостью, граф показывает, кто кому реально писал.
> - **Ключевые решения.**
>   - Пишет кто угодно кому угодно внутри роя; ограничения рёбрами `link` — спека 009.
>   - Рой завершается, когда агент-вход (`agent-1`) вызывает `finish`. Падение любого агента (лимит шагов, ошибка модели) валит рой с причиной `agent_failed`.
>   - Если агент-вход закончил ход текстом, не ждёт ответов участников, — агент один раз напоминает модели про `finish`; повторный текст становится результатом роя (Q-7); пустой повторный текст валит агента `empty_result`, а если после напоминания вход написал участникам — он ждёт их ответов. Ответ, обрезанный по `max_tokens`, — ошибка модели `max_tokens` (приёмка, D-82, D-85).
>   - История агента — в памяти процесса; Postgres — 003, журнал инструментов и возобновление — 008, бюджеты — 004.
> - **Меняет спеку 001:** эстафета (4.7.2), `AGENT_NEXT` и `AGENT_STEP_DELAY_MS` удаляются, завершение роя — по `agent-1`, а не по последнему агенту. Тексты и тесты AC-001-11, -15, -19, -20, -26, -27 переписываются под цикл с сохранением id (Q-6).
> - **Из бэклога:** D-13 → Q-1 (модель трейса), D-19 → Q-2 (асинхронный обработчик NATS).
> - **Что нужно от человека:** вопросы Q-1…Q-7 решены; поставить `ready`; для ручной проверки AC-022-26 — ключ OpenRouter в `.env.llm`.

## 1. Контекст и цель

Роадмап, этап 2 «Агенты думают», [раздел 1](../../AI_PLATFORM_ROADMAP.md#1-llm-gateway-и-litellm--единый-формат-и-учёт-денег) и [«Агент»](../../AI_PLATFORM_ROADMAP.md#агент): «минимальный агентный цикл: system prompt из роли, текстовый ответ и инструменты „написать агенту“, „завершить“. Цикл не знает о рое».

Сейчас агент из 001 выполняет детерминированную эстафету, gateway из 002 готов, но его никто, кроме теста и `llm:ping`, не вызывает.

Цель: рой из агентов с ролями решает задачу пользователя вместе, общаясь через шину; каждый шаг агента — вызов модели через gateway; переписка, шаги и стоимость вызовов видны в UI в реальном времени. Работает на профиле `test` (фейковый провайдер, CI без ключей) и `dev` (бесплатные модели OpenRouter).

## 2. Объём

**Входит:**
- ядро цикла `packages/agent-core/src/loop.ts`: контекст вызова, порт `ChatModel`, инструменты, 4 вида ответа модели, лимит шагов;
- агент роя в `agent-core`: промпт, инструменты `send_message` и `finish`, история в памяти, события `agent.step`, `agent.idle`;
- адаптер `packages/adapter-openai` (OpenAI SDK → `llm-gateway`);
- контракты: модель агента в `AgentDraft`, события `agent.step` и `agent.idle`, причина `agent_failed`;
- оркестратор: новый env агента, завершение роя по `agent-1`, `swarm.failed` при `agent.failed`;
- `adapter-docker`: адрес gateway в env песочницы;
- асинхронный обработчик подписки в `adapter-nats` (из D-19, по Q-2);
- проекция роя: статус `idle` по `agent.idle`, число шагов, модель агента, рёбра по фактическим сообщениям;
- фейковый провайдер: сценарии `__tool_calls__` и ответ на сообщение `role: tool`;
- UI: выбор модели в форме, строка шага в ленте, граф с произвольными рёбрами;
- правка текстов и тестов спеки 001 по Q-6.

**Не входит** (агент это не делает, даже если кажется логичным):
- ключи агентов, бюджеты, резерв и ledger — 004; `LLM_GATEWAY_TOKEN` до 004 остаётся общим;
- история агента, рои и события в Postgres — 003;
- журнал инструментов, возобновление агента после убийства песочницы, откат шагов — 008;
- граф процесса, рёбра `flow`/`link`, ограничение «кто кому пишет» — 009; координатор — 027;
- скиллы и `activate_skill` — 010;
- поток (`stream: true`) из агента — по Q-4 в 022 только обычный ответ;
- сжатие контекста, чат-бот, диалог — 018;
- «падение агента не валит рой» — этап 11 (015);
- инструменты, кроме `send_message` и `finish`; выход агента в интернет;
- общий хелпер повторов N-10 — 004 (здесь повторы делает OpenAI SDK, Q-4);
- резервные провайдеры (D-39), выбор модели роутером (D-76).

## 3. Требования

| ID | Требование | Приоритет |
|---|---|---|
| REQ-022-1 | `runAgentLoop` MUST получать всё через контекст вызова `AgentCallContext` и порт `ChatModel` и MUST NOT импортировать ничего о рое, шине и событиях. | MUST |
| REQ-022-2 | Цикл MUST обрабатывать 4 вида ответа модели: только текст; один `tool_call`; несколько `tool_calls` — исполняются параллельно, результаты добавляются в историю в порядке `tool_calls`; текст + `tool_calls`. | MUST |
| REQ-022-3 | Ошибка инструмента — неизвестное имя, невалидный JSON или аргументы не по схеме, отказ исполнения — MUST возвращаться модели сообщением `role: tool` с текстом `error: <причина>` и MUST NOT прерывать цикл. | MUST |
| REQ-022-4 | Цикл MUST останавливаться: на ответе без `tool_calls` (`text`); после шага, где инструмент вернул `stop` (`stopped`), без следующего вызова модели; при исчерпании `maxSteps` (`max_steps`), не делая вызова сверх лимита; на ошибке модели (`model_error`). | MUST |
| REQ-022-5 | Агент роя MUST строить системный промпт и сообщения из входящих по шаблонам 4.5 и держать одну историю на всё время жизни: каждое входящее сообщение продолжает её. | MUST |
| REQ-022-6 | Агенту MUST быть доступен `send_message` только к другим агентам роя (не к себе и не к `user`), и только если они есть; `finish` — только агенту-входу `AGENT_ENTRY`. | MUST |
| REQ-022-7 | На каждый ответ модели агент MUST публиковать `agent.step`; ход по входящему сообщению MUST заканчиваться ровно одним из `agent.idle`, `agent.result`, `agent.failed`. | MUST |
| REQ-022-8 | После `finish` или `agent.failed` агент MUST NOT вызывать модель: следующие входящие сообщения отбрасываются с записью `warn`. | MUST |
| REQ-022-9 | Каждый вызов модели MUST идти только в `llm-gateway` (`LLM_GATEWAY_URL`) с токеном, заголовками `x-swag-swarm-id`, `x-swag-agent-id`, `traceparent` текущего контекста, `stream: false` и `max_tokens = AGENT_MAX_TOKENS`. | MUST |
| REQ-022-10 | Оркестратор MUST передавать агенту env строго по 4.8; `adapter-docker` добавляет `NATS_URL`, `OTEL_EXPORTER_OTLP_ENDPOINT` и `LLM_GATEWAY_URL`. Ключей провайдеров и `LITELLM_MASTER_KEY` в env песочницы MUST NOT быть. | MUST |
| REQ-022-11 | Рой MUST завершаться `swarm.completed` по `agent.result` агента-входа; `agent.result` другого агента MUST игнорироваться. `agent.failed` любого агента роя в `running` MUST приводить к уборке и `swarm.failed` с `reason: agent_failed`, `detail: "<agentId>: <reason>"`. | MUST |
| REQ-022-12 | Проекция роя MUST применять правила 4.6. | MUST |
| REQ-022-13 | Тексты промптов, сообщений, ответов модели и аргументов инструментов MUST NOT попадать в логи и спаны агента (правило Q-4 спеки 016); в событиях платформы они есть. | MUST |
| REQ-022-14 | Обработчик подписки `adapter-nats` MAY возвращать `Promise`; адаптер MUST дожидаться его до закрытия спана `consumer`, обрабатывать сообщения одной подписки по одному в порядке поступления и записывать отказ в статус спана (по Q-2). | MUST |
| REQ-022-15 | В форме роя у каждого агента MUST выбираться модель из `PlatformModel`; без поля в API — `chat-small`. | MUST |
| REQ-022-16 | Лента роя в UI MUST показывать `agent.step` по формату 4.10; граф MUST рисовать рёбра из `SwarmView.edges`, включая обратные и непоследовательные. | MUST |
| REQ-022-17 | `npm run check` и CI MUST проходить без ключей провайдеров: сквозные тесты — на скриптовом `ChatModel` и фейковом провайдере. | MUST |
| REQ-022-18 | Рой из двух агентов на профиле `dev` SHOULD решать простую задачу (AC-022-26) за время меньше `SWARM_TIMEOUT_MS`. | SHOULD |
| REQ-022-19 | Агент-вход, закончивший ход итогом `text` без ожидаемых ответов (4.4), MUST один раз за ход продолжить цикл с напоминанием 4.5; если и после него итог `text` — MUST: при ожидаемых ответах — публиковать `agent.idle`; при пустом или `null` тексте — `agent.failed` `empty_result`; иначе — завершиться как по `finish` с этим текстом. При ожидаемых ответах до напоминания MUST публиковать `agent.idle` без напоминания (по Q-7; приёмка — D-82, D-85). | MUST |

## 4. Контракты

### 4.1. `@swag/contracts`

`llm.ts`:

```ts
// Модели платформы, одинаковые во всех профилях (002, Q-4). Для выбора в форме роя.
export const PlatformModel = z.enum(['chat-small', 'chat-large']);
export type PlatformModel = z.infer<typeof PlatformModel>;
```

`swarm.ts`:

```ts
export const AgentDraft = z.strictObject({
  name: z.string().trim().min(1).max(40),
  role: z.string().trim().min(1).max(500),
  model: PlatformModel.default('chat-small'),
});
// AgentSpec = AgentDraft.extend({ id: AgentId }) — без изменений, теперь с model.
export const ENTRY_AGENT_ID = 'agent-1'; // агент-вход: получает задачу от user и только он завершает рой
```

`events.ts` — новые варианты и причина:

```ts
z.strictObject({ ...Envelope, type: z.literal('agent.step'), data: z.strictObject({
  messageId: z.uuid(),                // входящее сообщение, на которое идёт ход
  stepIndex: z.number().int().min(1), // сквозной номер шага агента за всю жизнь, = номер вызова модели
  text: z.string().nullable(),        // content ответа модели; null — пусто
  toolCalls: z.array(z.strictObject({ id: z.string(), name: z.string() })), // в порядке ответа
}) }),
z.strictObject({ ...Envelope, type: z.literal('agent.idle'), data: z.strictObject({ messageId: z.uuid() }) }),
```

`swarm.failed.data.reason` дополняется `'agent_failed'`. `agent.failed` теперь публикует и агент (`source: 'agent'`), `data.reason` — `max_steps`, `model_error:<code>` (`code` — 4.3) или `empty_result` (4.4, шаг 5).

### 4.2. Порт модели и цикл — `packages/agent-core/src/loop.ts`

Формат сообщений — подмножество OpenAI Chat Completions:

```ts
export type ChatMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string | null; tool_calls?: ToolCall[] }
  | { role: 'tool'; tool_call_id: string; content: string };
export interface ToolCall { id: string; type: 'function'; function: { name: string; arguments: string } }
export interface ToolDefinition { name: string; description: string; parameters: Record<string, unknown> } // JSON Schema object

export interface ChatModelRequest {
  model: ModelId;
  messages: ChatMessage[];
  tools: ToolDefinition[];   // пустой — поле tools в запрос не идёт
  maxTokens: number;
}
export type ChatModelResult =
  | { ok: true; message: { content: string | null; tool_calls: ToolCall[] } } // tool_calls пустой, если их нет
  | { ok: false; error: { code: ChatModelErrorCode; message: string } };
export type ChatModelErrorCode = GatewayErrorCode | 'network' | 'timeout' | 'invalid_response' | 'max_tokens';

export interface ChatModel {
  complete(request: ChatModelRequest): Promise<ChatModelResult>; // не бросает: любая ошибка — ok: false
}

export interface AgentTool {
  definition: ToolDefinition;
  execute(args: unknown): Promise<ToolOutcome>; // args — уже JSON.parse; проверку схемы делает инструмент
}
export type ToolOutcome = { content: string; stop?: { result: string } };

export interface AgentCallContext {
  model: ModelId;
  systemPrompt: string;
  history: ChatMessage[];    // без system; цикл не мутирует массив
  input: ChatMessage;        // новое сообщение, обычно role: user
  tools: AgentTool[];
  limits: { maxSteps: number; maxTokens: number }; // maxSteps — сколько вызовов модели осталось
}
export interface AgentStep { stepIndex: number; text: string | null; toolCalls: { id: string; name: string }[] } // stepIndex с 1 внутри вызова
export type AgentLoopResult = { messages: ChatMessage[]; steps: number } & ( // messages — input и всё добавленное после
  | { kind: 'text'; text: string | null }
  | { kind: 'stopped'; result: string }
  | { kind: 'max_steps' }
  | { kind: 'model_error'; error: { code: ChatModelErrorCode; message: string } });

export function runAgentLoop(
  deps: { model: ChatModel; onStep(step: AgentStep): Promise<void> },
  context: AgentCallContext,
): Promise<AgentLoopResult>;
```

Алгоритм:
1. `messages = [input]`, `steps = 0`.
2. Если `steps === maxSteps` → `max_steps`.
3. `complete({ model, messages: [system, ...history, ...messages], tools: definitions, maxTokens })`, `steps += 1`. Ошибка → `model_error`.
4. Добавить `{ role: 'assistant', content, tool_calls }` (`tool_calls` — только если не пустой), вызвать `onStep`.
5. Нет `tool_calls` → `text`.
6. Все `tool_calls` исполняются через `Promise.all`. Для каждого: инструмент по имени (нет — `error: unknown tool <name>`), `JSON.parse(arguments)` (ошибка — `error: invalid JSON arguments`), `execute` (исключение — `error: <message>`). Результаты добавляются как `role: tool` в порядке `tool_calls`.
7. Хоть один результат со `stop` → `stopped` с `result` первого такого. Иначе — шаг 2.

`ModelId` и `GatewayErrorCode` — типы из `@swag/contracts`; других импортов у `loop.ts` нет.

### 4.3. `packages/adapter-openai`

```ts
export interface OpenAiChatModelOptions {
  baseUrl: string;        // LLM_GATEWAY_URL, например http://llm-gateway:3002/v1
  token: string;          // LLM_GATEWAY_TOKEN
  caller: LlmCaller;      // → x-swag-swarm-id, x-swag-agent-id
  traceparent(): string | null; // currentTraceparent из adapter-telemetry; null — заголовок не ставится
  timeoutMs: number;      // AGENT_LLM_TIMEOUT_MS
  maxRetries: number;     // AGENT_LLM_MAX_RETRIES, повторы SDK (Q-4)
}
export function createOpenAiChatModel(options: OpenAiChatModelOptions): ChatModel;
```

- Пакет `openai` — последняя стабильная версия, опубликованная не позже чем за 2 недели до реализации; версия — в README пакета и журнале.
- Запрос: `client.chat.completions.create({ model, messages, tools?: [{ type: 'function', function: definition }], max_tokens, stream: false })`, заголовки — через `defaultHeaders` и `headers` запроса (`traceparent` на каждый вызов).
- Ответ: `choices[0].message` → `{ content, tool_calls }`; нет `choices[0]` — `invalid_response`; `choices[0].finish_reason === 'length'` — ошибка `max_tokens` с `message` про лимит `max_tokens`, даже если в ответе есть текст или вызовы: обрезанный ответ неполон (приёмка, D-85).
- Ошибки SDK: `APIError` с телом gateway — `code` из `error.code`, если он в `GatewayErrorCode`, иначе по статусу: `429` — `rate_limited`, прочее — `upstream_error` (приёмка, D-80); `APIConnectionTimeoutError` — `timeout`; `APIConnectionError` — `network`. `message` — из ошибки, без токена (заменить вхождения `token` на `***`).

### 4.4. Агент роя — `packages/agent-core/src/index.ts`

```ts
export interface AgentPeer { id: AgentId; name: string; role: string }
export interface AgentConfigCore {
  swarmId: string;
  agentId: AgentId;
  agentName: string;
  agentRole: string;
  model: ModelId;
  peers: AgentPeer[];        // другие агенты роя, в порядке id
  entryAgentId: AgentId;
  maxSteps: number;          // на всю жизнь агента
  maxTokens: number;
}
export interface AgentCoreDeps { version; bus; clock; ids; log; trace; model: ChatModel; config: AgentConfigCore } // timers удаляется
export interface AgentBus {
  subscribe(subject: string, handler: (raw: unknown) => Promise<void>): Promise<void>; // по Q-2: адаптер ждёт и сериализует
  publishEvent(event: PlatformEventInput): Promise<void>;
  publishMessage(message: BusMessage): Promise<void>;
}
```

Ход по входящему `BusMessage` (проверки схемы и адресата — как в 001):
1. Агент в `done` или `failed` → `warn` `message dropped`, `reason: agent_finished`, конец.
2. `agent.working`.
3. `runAgentLoop` с `history` агента, `input` по 4.5, инструментами по 4.5, `maxSteps = config.maxSteps − уже сделанные шаги`; `onStep` публикует `agent.step` со сквозным `stepIndex`.
4. История агента += `result.messages`.
5. Только у агента-входа (по Q-7). Агент держит множество `awaiting` — id участников, которым он отправил `send_message` и от которых с тех пор не приходило сообщения: отправка добавляет `to`, входящее от участника убирает `from`. Если `kind: text`, `awaiting` пусто и в этом ходе напоминания ещё не было — история += напоминание 4.5 (`role: user`), снова шаг 3 с оставшимися шагами. Если после напоминания снова `text`: `awaiting` не пусто — итог остаётся `text` (агент ждёт участников, D-82); текст `null` или из одних пробелов — итог `empty_result`; иначе — `stopped` с `result = text` (приёмка, D-85).
6. По `kind`: `text` → `agent.idle`; `stopped` → `agent.result` с `text = result`, агент `done`; `max_steps` → `agent.failed` `max_steps`; `model_error` → `agent.failed` `model_error:<code>`; `empty_result` → `agent.failed` `empty_result`; после `agent.failed` агент `failed`.
7. Лог `debug` `turn finished` с `messageId`, `kind`, `steps`.

### 4.5. Промпт, сообщения и инструменты

Системный промпт (строки через `\n`, блок участников — по строке на каждого; без участников блок и строка про `send_message` не выводятся):

```
Ты — агент «{agentName}» в команде агентов. Твоя роль: {agentRole}
Участники команды:
- {peer.id} «{peer.name}»: {peer.role}
Писать участникам можно только инструментом send_message. Текст ответа без инструмента видит только платформа.
```

и последняя строка — у агента-входа:

```
Задачу тебе ставит пользователь. Когда задача решена, вызови finish с итоговым результатом: его получит пользователь.
```

у остальных:

```
Результат своей работы отправь через send_message тому, кто дал тебе задание.
```

Входящее сообщение → `{ role: 'user', content }`:
- от `user`: `Задача от пользователя:\n{text}`;
- от агента: `Сообщение от {from} «{peer.name}»:\n{text}`.

Напоминание агенту-входу (4.4, шаг 5): `Ты ответил текстом без инструмента, пользователь его не увидит. Если задача решена — вызови finish с итоговым результатом. Если нужна работа участников — напиши им через send_message.`

Инструменты:

| Имя | Кому | `parameters` | Исполнение | Результат |
|---|---|---|---|---|
| `send_message` | есть `peers` | `{ type: 'object', properties: { to: { type: 'string', enum: [id участников] }, text: { type: 'string', minLength: 1 } }, required: ['to', 'text'], additionalProperties: false }` | проверка Zod; `BusMessage` от себя к `to` | `ok: отправлено {to}`; ошибка — `error: <path>: <message>` |
| `finish` | агент-вход | `{ type: 'object', properties: { result: { type: 'string', minLength: 1 } }, required: ['result'], additionalProperties: false }` | проверка Zod | `ok` и `stop: { result }` |

Описания: `send_message` — `Отправить сообщение участнику команды`, `finish` — `Завершить задачу и вернуть итог пользователю`.

### 4.6. Проекция роя — `packages/api-integration/src/swarm-view.ts`

`SwarmView.agents[]` дополняется `model: PlatformModel` и `steps: number`. `edges` при `swarm.created` — пустой массив (цепочки больше нет).

Изменения таблицы 4.4 спеки 001:

| Событие | Агент |
|---|---|
| `bus.message` | `to` — `messagesIn + 1`; если `from` — агент: `messagesOut + 1`, ребро `from → to` создаётся с `messages: 1` или увеличивается; **статус не меняется** |
| `agent.step` | `steps + 1` |
| `agent.idle` | `idle`, если не `done`, `failed`, `stopped` |

### 4.7. Фейковый провайдер — `infra/llm/fake-provider/server.ts`

Новые правила, проверяются раньше таблицы 4.12 спеки 002, только для ответа без потока:

| Условие | Ответ |
|---|---|
| последнее сообщение `role: 'tool'` | `content: 'fake reply'` без `tool_calls`, `usage` по умолчанию |
| текст последнего сообщения содержит `__tool_calls__` | всё после маркера — JSON `[{ name: string, arguments: object }]` → `message: { content: null, tool_calls: [{ id: 'call_<i>', type: 'function', function: { name, arguments: JSON.stringify(arguments) } }] }`, `finish_reason: 'tool_calls'`, `usage` по умолчанию; невалидный JSON или JSON не той формы (не массив, `name` не строка, `arguments` не объект) — правило не срабатывает (приёмка, D-78) |

### 4.8. Env агента

Заменяет таблицу 4.7.1 спеки 001. `AGENT_NEXT` и `AGENT_STEP_DELAY_MS` удаляются (и из `OrchestratorConfig`, `.env.example`).

| Переменная | Кто ставит | Пример | Назначение |
|---|---|---|---|
| `NATS_URL`, `OTEL_EXPORTER_OTLP_ENDPOINT` | `adapter-docker` | — | как в 001 и 016 |
| `LLM_GATEWAY_URL` | `adapter-docker` из `DOCKER_AGENT_LLM_GATEWAY_URL` | `http://llm-gateway:3002/v1` | gateway изнутри песочницы |
| `TELEMETRY_FLUSH_TIMEOUT_MS` | ядро | — | как в 016 |
| `TRACEPARENT` | `adapter-docker` | — | как в 016 (AC-016-10): порт `TraceContext` отдаёт только `traceId`, ядро `TRACEPARENT` не ставит (приёмка, D-83) |
| `SWARM_ID`, `AGENT_ID`, `AGENT_NAME`, `AGENT_ROLE` | ядро | — | как в 001 |
| `AGENT_MODEL` | ядро | `chat-small` | `AgentSpec.model` |
| `AGENT_PEERS` | ядро | `[{"id":"agent-2","name":"Редактор","role":"…"}]` | JSON `AgentPeer[]`: остальные агенты роя |
| `AGENT_ENTRY` | ядро | `agent-1` | `ENTRY_AGENT_ID` |
| `AGENT_MAX_STEPS` | ядро из `AGENT_MAX_STEPS` оркестратора | `20` | лимит вызовов модели на агента |
| `AGENT_MAX_TOKENS` | ядро из `AGENT_MAX_TOKENS` оркестратора | `2048` | `max_tokens` вызова |
| `LLM_GATEWAY_TOKEN` | ядро из `LLM_GATEWAY_TOKEN` оркестратора | — | общий токен gateway до 004 |

`AgentConfig` дополнительно: `AGENT_LLM_TIMEOUT_MS` (по умолчанию `120000`) и `AGENT_LLM_MAX_RETRIES` (по умолчанию `2`) — оркестратор их не передаёт.

`OrchestratorConfig`: `+ AGENT_MAX_STEPS`, `+ AGENT_MAX_TOKENS` (целые ≥ 1), `+ LLM_GATEWAY_TOKEN` (`min(32)`), `+ DOCKER_AGENT_LLM_GATEWAY_URL` (URL). `.env.example`:

```
# Спека 022. Агентный цикл.
AGENT_MAX_STEPS=20
AGENT_MAX_TOKENS=2048
DOCKER_AGENT_LLM_GATEWAY_URL=http://llm-gateway:3002/v1
```

Значения — по Q-5. Оркестратору в compose — `depends_on: llm-gateway (healthy)`.

### 4.9. Оркестратор

- `agentSpec` строит env по 4.8.
- `handleEvent`: `agent.result` от `ENTRY_AGENT_ID` в `running` → `swarm.completed`; `agent.failed` (любой `source`) в `running` → уборка и `swarm.failed` `agent_failed`, `detail = "<agentId>: <reason>"`.

### 4.10. UI

- Форма: у агента выпадающий список модели из `PlatformModel.options`, по умолчанию `chat-small`.
- `ui-core`: `formatAgentStep(data): string` — `шаг {stepIndex}` + (`: {text}`, если `text` не null) + (` → {имена через ", "}`, если `toolCalls` не пуст). Пример: `шаг 2: Передаю редактору → send_message`.
- Граф: агенты по кругу в порядке id; каждое ребро `from → to` — стрелка с числом сообщений; встречные рёбра рисуются двумя дугами, не накладываясь. У агента — модель и число шагов. Свой SVG, без библиотеки (как в 001).

### 4.11. Телеметрия

- По Q-1: рой — один трейс, как в 016.
- По Q-2: спан `process swarm.<id>.agent.<id>.inbox` длится весь ход агента; HTTP-вызовы gateway — внутри него, родитель серверного спана gateway — `traceparent` из 4.3.
- Логи агента: `turn finished` (4.4), `message dropped`; поля — только id, числа, `kind`, коды ошибок.

### 4.12. Пакеты

| Пакет | Изменение |
|---|---|
| `packages/adapter-openai` | новый: `ChatModel` на `openai`; зависимости `openai`, `@swag/agent-core` (типы), `@swag/contracts` |
| `packages/agent-core` | `loop.ts`, агент роя вместо эстафеты |
| `apps/agent` | собирает `adapter-openai`, новый `AgentConfig` |
| `packages/adapter-nats`, `packages/orchestrator-core`, `packages/adapter-docker`, `packages/api-integration`, `packages/contracts`, `packages/config`, `packages/ui-core`, `apps/ui/cabinet`, `infra/llm/fake-provider` | по разделам выше |

## 5. Критерии приёмки

- **AC-022-1** — *Given* `SwarmCreateRequest`, *When* разбор, *Then* агент без `model` получает `chat-small`, с `chat-large` — проходит, с `gpt-4` — ошибка с путём `agents.0.model`; `agent.step`, `agent.idle` и `swarm.failed` с `agent_failed` проходят `PlatformEventInput`.
- **AC-022-2** — *Given* события `swarm.created`, `agent.working`, `agent.step` ×2, `bus.message` agent-2 → agent-1, `bus.message` agent-1 → agent-2, `agent.idle`, *When* `projectSwarm`, *Then* `steps: 2`, рёбра `agent-2 → agent-1` и `agent-1 → agent-2` по 1 сообщению, статус после `bus.message` — `working`, после `agent.idle` — `idle`; `agent.idle` после `agent.result` статус `done` не меняет.
- **AC-022-3** — *Given* скриптовый `ChatModel`, отвечающий текстом, *When* `runAgentLoop`, *Then* `kind: text`, `steps: 1`, `onStep` вызван один раз, `messages` = `[input, assistant]`, модель получила `[system, ...history, input]`.
- **AC-022-4** — *Given* ответы «один `tool_call`», затем текст, *When* цикл, *Then* инструмент исполнен с разобранными аргументами, во втором запросе есть `assistant` с `tool_calls` и `tool` с тем же `tool_call_id`, `kind: text`, `steps: 2`.
- **AC-022-5** — *Given* ответ с двумя `tool_calls`, инструменты которых завершаются в обратном порядке, *When* цикл, *Then* второй инструмент стартовал до завершения первого, результаты `tool` в истории — в порядке `tool_calls`.
- **AC-022-6** — *Given* ответ «текст + `tool_call`», *When* цикл, *Then* `onStep` получил и `text`, и имя инструмента, инструмент исполнен.
- **AC-022-7** — *Given* `tool_calls` с неизвестным именем, невалидным JSON и инструментом, который бросает, *When* цикл, *Then* три результата `error: …` по 4.2, цикл продолжает и завершается на следующем ответе.
- **AC-022-8** — *Given* ответ с двумя `tool_calls`, один из которых возвращает `stop`, *When* цикл, *Then* оба исполнены, `kind: stopped` с его `result`, третьего вызова модели нет.
- **AC-022-9** — *Given* `maxSteps: 2` и модель, всегда отвечающая `tool_call`, *When* цикл, *Then* ровно 2 вызова модели, `kind: max_steps`; при `maxSteps: 0` — 0 вызовов.
- **AC-022-10** — *Given* модель с `ok: false, code: rate_limited`, *When* цикл, *Then* `kind: model_error` с этим кодом.
- **AC-022-11** — *Given* исходник `packages/agent-core/src/loop.ts`, *When* тест разбирает его импорты, *Then* есть только `import type` из `@swag/contracts`.
- **AC-022-12** — *Given* `agent-core` агента-входа с двумя участниками и агента без участников, *When* первый ход, *Then* системный промпт и `input` совпадают с шаблонами 4.5 посимвольно; у входа инструменты `send_message` (с `enum` из id участников) и `finish`; у агента без участников и не входа — инструментов нет.
- **AC-022-13** — *Given* `agent-core` `agent-2` со скриптовой моделью «`send_message` к `agent-1`», затем «текст», *When* два входящих сообщения подряд, *Then* по каждому: `agent.working`, `agent.step` ×2 (`stepIndex` 1, 2 и 3, 4), `BusMessage` к `agent-1`, `agent.idle`; второй ход получил историю первого; второй ход начался после конца первого.
- **AC-022-14** — *Given* модель вызывает `send_message` к себе, к `user` и к несуществующему `agent-9`, *When* ход, *Then* `BusMessage` не публикуется, модель получает три `error: …`.
- **AC-022-15** — *Given* агент-вход, модель вызывает `finish`, *When* ход, затем новое сообщение, *Then* `agent.result` с текстом результата, второе сообщение отброшено с `warn` `reason: agent_finished`, модель больше не вызывалась.
- **AC-022-16** — *Given* `AGENT_MAX_STEPS=3` и модель, всегда вызывающая инструмент, *When* ход, *Then* 3 шага и `agent.failed` `max_steps`; *Given* модель с ошибкой `upstream_timeout`, *Then* `agent.failed` `model_error:upstream_timeout`; дальше сообщения отбрасываются.
- **AC-022-28** — *Given* агент-вход со скриптовой моделью, *When* ход по задаче пользователя и модель отвечает текстом, затем после напоминания снова текстом «итог», *Then* в истории ровно одно напоминание по шаблону 4.5, `agent.result` с `text: "итог"`, агент `done`; *When* модель после напоминания вызывает `finish`, *Then* `agent.result` с результатом `finish`; *Given* агент-вход отправил `send_message` к `agent-2` и `agent-3`, *When* пришёл ответ только от `agent-2` и модель ответила текстом, *Then* напоминания нет, `agent.idle`; *When* затем пришёл ответ `agent-3` и модель ответила текстом, *Then* напоминание есть. Агент не-вход при итоге `text` напоминания не получает. *Given* агент-вход без ожидаемых ответов, *When* после напоминания модель вызывает `send_message` к `agent-2` и отвечает текстом, *Then* `agent.idle`, агент не `done`; *When* после напоминания модель отвечает `content: null` или `"  "`, *Then* `agent.failed` `empty_result`, `agent.result` нет (приёмка, D-82, D-85).
- **AC-022-17** — *Given* `orchestrator-core` с фейковым провайдером песочниц, *When* `launch` с тремя агентами, *Then* env каждой песочницы — ровно ключи 4.8, которые ставит ядро; `AGENT_PEERS` без самого агента, `AGENT_ENTRY=agent-1`, `AGENT_MODEL` из плана; ни одного ключа `*_API_KEY`, `LITELLM_MASTER_KEY`, `AGENT_NEXT`. *Given* `adapter-docker`, *Then* у контейнера есть `LLM_GATEWAY_URL` из `DOCKER_AGENT_LLM_GATEWAY_URL`.
- **AC-022-18** — *Given* рой в `running`, *When* `agent.result` от `agent-2`, *Then* рой остаётся `running`; *When* `agent.result` от `agent-1`, *Then* уборка и `swarm.completed`; *Given* другой рой, *When* `agent.failed` `max_steps` от `agent-3`, *Then* уборка и `swarm.failed` `agent_failed`, `detail: "agent-3: max_steps"`.
- **AC-022-19** — *Given* фейковый провайдер в процессе (`startFakeProvider`) на месте gateway, *When* `createOpenAiChatModel(...).complete` с инструментами и маркером `__tool_calls__`, *Then* при `baseUrl = <url фейка>/v1` в `requests` — путь `/v1/chat/completions`, `authorization: Bearer <token>`, оба заголовка вызывающего, `traceparent`, тело с `model`, `tools`, `max_tokens`, `stream: false`; результат — `tool_calls` из маркера. Ответ с `finish_reason: 'length'` — ошибка `max_tokens` и при непустом `content`, и при `tool_calls` (подставной HTTP-сервер). С `__fail_429__` и `maxRetries: 0` — `rate_limited`; с ответом gateway `400 {error:{code:'model_not_found'}}` — `model_not_found`; без сервера — `network`.
- **AC-022-20** — *Given* фейковый провайдер, *When* последнее сообщение `role: tool` при наличии `tools`, *Then* ответ — текст без `tool_calls`; *When* маркер `__tool_calls__` с двумя вызовами, *Then* два `tool_calls` с `call_0`, `call_1`; невалидный JSON после маркера — ответ по умолчанию 002.
- **AC-022-21** — *Given* `api-core`, `orchestrator-core` и три `agent-core` в одном процессе: шина в памяти, фейковый провайдер песочниц, скриптовый `ChatModel` на агента (`agent-1`: `send_message` → `agent-2`, после ответа — `finish`; `agent-2`: `send_message` → `agent-3`; `agent-3`: `send_message` → `agent-1`), *When* `createSwarm`, *Then* рой `completed` с `result` из `finish`, рёбра `1→2`, `2→3`, `3→1` по 1 сообщению, песочниц 0, `seq` непрерывны. Сквозной тест без Docker и сети.
- **AC-022-22** — *Given* `adapter-nats` с экспортом спанов в память и NATS, *When* обработчик возвращает `Promise`, который завершается через 200 мс, и второй — отказом, *Then* длительность спана `process …` ≥ 200 мс, у второго спана статус `ERROR`; второе сообщение подписки начало обрабатываться после конца первого.
- **AC-022-23** — *Given* `ui-core`, *When* форма без модели у агента, *Then* в `SwarmsApi.create` уходит `chat-small`; `formatAgentStep` даёт строки по 4.10 для трёх случаев (только текст, только инструменты, оба).
- **AC-022-24** — *Given* агент с телеметрией в память и маркерами в тексте задачи, ответа модели и аргументов `send_message`, *When* ход, *Then* ни одна запись лога и ни один атрибут спана не содержит этих маркеров.
- **AC-022-25** `[manual]` — *Given* `npm run up` с `LLM_PROFILE=test`, *When* в UI рой из `agent-1` и `agent-2` с задачей-скриптом на `__tool_calls__` (`agent-1` пишет `agent-2`, тот отвечает `agent-1`, `agent-1` вызывает `finish`; строку задачи собирает `JSON.stringify`, пример — в журнал), *Then* рой `completed`, в ленте строки шагов, сообщений и `llm.call` с токенами и стоимостью `$0.009960`, граф показывает рёбра в обе стороны, `docker ps -a --filter label=swag.kind` пуст. Проверка: скриншоты и вывод в журнал.
- **AC-022-26** `[manual]` (из S-3) — *Given* `LLM_PROFILE=dev` и ключ OpenRouter, *When* в UI рой «Автор» (`chat-small`, «пишет четверостишие на тему задачи») и «Редактор» (`chat-small`, «проверяет и правит текст, возвращает автору») с задачей «четверостишие про осень», *Then* рой `completed` до `SWARM_TIMEOUT_MS`, результат — четверостишие, стоимость `llm.call` 0; из события в UI открывается трейс в Grafana, в нём спаны ходов агентов и вызовы gateway внутри них. Проверка: время, число шагов, скриншоты — в журнал.
- **AC-022-27** `[manual]` — *Given* рой на профиле `test` с задачей, где агенты пишут друг другу по кругу без `finish`, *When* «Стоп» в UI, *Then* рой `stopped`, все агенты `stopped`, контейнеров нет (заменяет AC-001-27, Q-6).

## 6. Нефункциональные требования

| ID | Требование | Как измеряется |
|---|---|---|
| NFR-022-1 | `npm test` остаётся быстрее 60 с без тестов, которым нужен Docker. | время команды |
| NFR-022-2 | Точка отсчёта без порога: время и число шагов роя AC-022-26 на `dev`. | 3 прогона, таблица в журнале |

## 7. Безопасность: что не должно сломаться

- В песочнице нет ключей провайдеров и мастер-ключа LiteLLM → AC-022-17. `LLM_GATEWAY_TOKEN` в песочнице есть — известное ограничение до 004 (ключ агента), токен не попадает в логи и тексты ошибок → AC-022-19 (`***`), AC-022-24.
- Агент ходит к моделям только через gateway, адрес задаёт платформа, не модель и не задача → AC-022-17, AC-022-19.
- Модель не может написать в чужой рой, себе или от имени `user`: адресат — только из `peers`, рой — свой → AC-022-14.
- Зацикленный рой не живёт бесконечно: `AGENT_MAX_STEPS` на агента и `SWARM_TIMEOUT_MS` на рой → AC-022-9, AC-022-16, AC-001-17.
- Тексты промптов и ответов не попадают в логи и спаны → AC-022-24.
- Пользовательский и модельный текст в UI — только интерполяцией, без `innerHTML` (правило 001, 4.8) → ревью.
- `npm run check` не тратит деньги и не требует ключей → AC-022-21, REQ-022-17.

## 8. Задачи для агента

Выполняются по порядку. После каждой задачи — коммит. Каждая рассчитана на один бриф субагенту.

- [x] **T-1.** `contracts`: `PlatformModel`, `model` в `AgentDraft`, `ENTRY_AGENT_ID`, события `agent.step`, `agent.idle`, причина `agent_failed` (4.1); глоссарий сверен. Закрывает: REQ-022-15, AC-022-1. Готово, когда: тесты `contracts` зелёные.
- [x] **T-2.** `api-integration`: правила проекции 4.6, `model` и `steps` в `SwarmView`, пустые рёбра при создании; обновить тест AC-001-2 под новые правила. Закрывает: REQ-022-12, AC-022-2. Готово, когда: тесты пакета зелёные.
- [x] **T-3.** Фейковый провайдер: два правила 4.7. Закрывает: AC-022-20. Готово, когда: тесты 002 и новый тест зелёные.
- [x] **T-4.** `agent-core/src/loop.ts`: типы 4.2 и `runAgentLoop`, тесты со скриптовым `ChatModel`. Закрывает: REQ-022-1…4, AC-022-3…11. Готово, когда: тесты пакета зелёные, `arch:check` проходит.
- [x] **T-5.** `adapter-nats`: асинхронный обработчик по REQ-022-14. Закрывает: REQ-022-14, AC-022-22. Готово, когда: тест на NATS зелёный, `api` и `orchestrator` работают без правок.
- [x] **T-6.** `agent-core`: промпт, сообщения и инструменты 4.5 (чистые функции `systemPrompt`, `inboxMessage`, `swarmTools`). Закрывает: REQ-022-5, REQ-022-6, AC-022-12, AC-022-14. Готово, когда: тесты зелёные.
- [x] **T-7.** `agent-core`: агент роя по 4.4 вместо эстафеты, порт `AgentBus` с `Promise`, удалить `timers` и эстафету; тест AC-001-19 переписать на ход агента. Закрывает: REQ-022-7, REQ-022-8, AC-022-13, AC-022-15, AC-022-16. Готово, когда: тесты пакета зелёные.
- [x] **T-7a.** `agent-core/src/index.ts`: напоминание агенту-входу по 4.4 шаг 5 — множество `awaiting`, текст напоминания 4.5 (константа рядом с шаблонами T-6), повторный текст как `stopped`. Закрывает: REQ-022-19, AC-022-28. Готово, когда: тест AC-022-28 и тесты T-7 зелёные.
- [x] **T-8.** `packages/adapter-openai`: `createOpenAiChatModel` по 4.3, README. Закрывает: REQ-022-9, AC-022-19. Готово, когда: тест против `startFakeProvider` зелёный.
- [x] **T-9.** `config`: `AgentConfig` и `OrchestratorConfig` по 4.8, `.env.example`. Готово, когда: тесты `config` зелёные.
- [x] **T-10.** `apps/agent`: сборка `adapter-openai` (`traceparent` из `adapter-telemetry`), разбор `AGENT_PEERS`; тест AC-022-24 с экспортом в память. Закрывает: REQ-022-13, AC-022-24. Готово, когда: тесты оболочки зелёные.
- [x] **T-11.** `orchestrator-core`: env 4.8, завершение и падение по 4.9; тесты AC-001-11, AC-001-15 переписать. Закрывает: REQ-022-10, REQ-022-11, AC-022-17 (ядро), AC-022-18. Готово, когда: тесты пакета зелёные.
- [x] **T-12.** `adapter-docker` и `apps/orchestrator`: `LLM_GATEWAY_URL` из `DOCKER_AGENT_LLM_GATEWAY_URL`; compose — `depends_on` оркестратора на `llm-gateway`. Закрывает: AC-022-17 (адаптер). Готово, когда: тест адаптера на Docker зелёный.
- [x] **T-13.** Сквозной тест в процессе AC-022-21 вместо AC-001-20 (тест AC-001-20 переписать на тот же сценарий). Закрывает: REQ-022-17, AC-022-21. Готово, когда: тест зелёный без Docker.
- [x] **T-14.** `ui-core`: модель в форме, `formatAgentStep`. Закрывает: AC-022-23. Готово, когда: тесты `ui-core` зелёные.
- [x] **T-15.** `apps/ui/cabinet`: выбор модели в форме, строка шага в ленте, граф по 4.10. Закрывает: REQ-022-16. Готово, когда: сборка UI зелёная, ручная проверка в AC-022-25.
- [x] **T-16.** Спека 001 по Q-6: тексты 4.7.1, 4.7.2 и AC-001-11, -15, -19, -20, -26, -27 со ссылкой «изменено спекой 022»; README `agent-core`, `apps/agent`, `orchestrator-core`, `adapter-docker`, `adapter-nats`, `api-integration`, `ui-core`, `cabinet`, `contracts`, `config`, фейкового провайдера и корневой. Готово, когда: `npm run check` зелёный.
- [x] **T-17.** Ручные проверки AC-022-25…27 и замер NFR-022-2, сценарий S-3 — статус `ручной`. Закрывает: REQ-022-18, AC-022-25…27, NFR-022-2. Готово, когда: результаты в журнале.
- [x] **T-18.** Решения приёмки D-82, D-85: `adapter-openai` — `finish_reason: 'length'` → `max_tokens` (4.3); `agent-core` — `max_tokens` в `ChatModelErrorCode` (4.2), шаг 5 алгоритма 4.4 (`awaiting` после напоминания, `empty_result`). Закрывает: REQ-022-19, AC-022-19, AC-022-28. Готово, когда: тесты пакетов зелёные, README и глоссарий обновлены.
- [x] **T-19.** Тексты 016 и 001 по решениям приёмки D-81 и D-84. Готово, когда: `npm run check` зелёный.

## 9. Открытые вопросы

Все вопросы решены.

**Решения приёмки (человек, 2026-10-29)** — вопросы D-78…D-85 из `questions.md`:
- D-78 — JSON не той формы после `__tool_calls__` — «правило не срабатывает» (4.7), как сделано.
- D-79 — промпт агента без участников и пустое имя неизвестного отправителя — оставить, как сделано.
- D-80 — `429` без `error.code` → `rate_limited` (4.3), как сделано.
- D-81 — текст 016 (таблица 4.8, AC-016-6) переходит на лог `turn finished` с пометкой «изменено спекой 022» → T-19.
- D-82 — текст после напоминания при непустом `awaiting` — `agent.idle` (4.4, шаг 5) → T-18.
- D-83 — `TRACEPARENT` ставит адаптер Docker, как в 016 (4.8), как сделано.
- D-84 — «б»: в 001 переписать REQ-001-1, REQ-001-11, правила рёбер 4.4, таблицу env 4.9 и граф 4.8 с пометкой «изменено спекой 022»; задачи и вопросы 001 — история → T-19.
- D-85 — воспроизведено на `dev` (6 роёв, 2026-10-29): в 4 из них ответ модели обрезан по `max_tokens` (`finish_reason: length`: рассуждения съели все 2048 токенов, у части провайдеров рассуждения ещё и в `content`, и агент принимал их за ответ). Решение: обрезанный ответ — ошибка модели `max_tokens` (4.3), пустой повторный текст входа — `empty_result` (4.4, шаг 5) → T-18. Профиль `dev` — N-14.

- [x] **Q-1. Модель трейса для долгих роёв** (из D-13). *(Claude, 2026-10-28)*
  В 016 рой — один трейс. Варианты: **(а)** оставить «рой = трейс» в 022; **(б)** ход агента — свой трейс со span link на трейс-родителя; **(в)** таймер оркестратора — свой трейс со ссылкой на трейс запуска.
  **Рекомендация — «а» в 022, решение «б» перенести в 018.** Рой в 022 ограничен `SWARM_TIMEOUT_MS` (5 мин) и `AGENT_MAX_STEPS`: трейс — сотни спанов, Tempo это держит. Долгая жизнь (дни) появляется у диалога бота — там вопрос и решать. Если «а» — D-13 возвращается в `questions.md` с адресом 018.
  **Решение человека (2026-10-28): «а» в 022, «б» — в 018.** D-13 возвращён в `questions.md` с адресом 018.
- [x] **Q-2. Асинхронный обработчик NATS** (из D-19). *(Claude, 2026-10-28)*
  Варианты: **(а)** обработчик возвращает `Promise`, адаптер ждёт его до `span.end()` и обрабатывает сообщения подписки по одному; **(б)** оставить синхронный, ход агента мерить отдельным спаном в оболочке агента; **(в)** связать с D-13.
  **Рекомендация — «а».** Ход агента длится секунды и минуты: спан `consumer` покажет его реальную длительность и ошибку, вызовы gateway встанут внутрь него. Агенту и так нужна обработка по одному (сейчас — своя очередь в `agent-core`, она уходит). `api` и `orchestrator` не меняются: синхронный обработчик — частный случай. Минус: медленный обработчик оркестратора задерживает следующие события его подписки — сейчас обработка там короткая.
  **Решение человека (2026-10-28): «а».** → REQ-022-14, T-5.
- [x] **Q-3. Кто завершает рой и что валит его.** *(Claude, 2026-10-28)*
  Варианты завершения: **(а)** только агент-вход `agent-1` вызывает `finish` (задача пришла ему, он и отвечает пользователю); **(б)** `finish` у всех, рой завершает первый вызов; **(в)** у последнего агента формы, как в 001.
  Варианты падения: **(а)** `agent.failed` любого агента → `swarm.failed agent_failed`; **(б)** падение не-входа сообщается входу сообщением, рой живёт.
  **Рекомендация — «а» и «а».** Один вход и один выход совпадают с `entry`/`exit` будущего `SwarmPlan`; «падение агента не валит рой» — критерий этапа 11, сейчас простое правило проще проверить.
  **Решение человека (2026-10-28): «а» и «а».**
- [x] **Q-4. Параметры вызова модели.** *(Claude, 2026-10-28)*
  - Поток: **рекомендация — `stream: false`**. Агенту нужен ответ целиком, `usage` в обычном ответе приходит всегда, потоковый путь gateway уже проверен в 002. Поток понадобится чат-боту (018) или живому выводу токенов в UI.
  - Повторы: **рекомендация — встроенные повторы OpenAI SDK** (`maxRetries: 2`, экспоненциальная пауза, учёт `Retry-After`, на `408`, `409`, `429`, `5xx` и сеть) — не свой код; общий хелпер N-10 появится в 004 для внешних API. Альтернатива — без повторов, ошибка сразу валит агента: на `dev` с бесплатными моделями `429` частый.
  - Таймаут вызова — `AGENT_LLM_TIMEOUT_MS=120000`, равен `LLM_GATEWAY_UPSTREAM_TIMEOUT_MS`.
  **Решение человека (2026-10-28): по рекомендации** — `stream: false`, повторы OpenAI SDK, таймаут `AGENT_LLM_TIMEOUT_MS=120000`.
- [x] **Q-5. Лимиты.** *(Claude, 2026-10-28)*
  `AGENT_MAX_STEPS=20`, `AGENT_MAX_TOKENS=2048`, `SWARM_TIMEOUT_MS` остаётся `300000`. Рекомендация — эти значения: 8 агентов × 20 шагов — потолок 160 вызовов на рой; бесплатные модели отвечают за секунды, задачи демо укладываются в 5 минут. После замера NFR-022-2 значения можно пересмотреть.
  **Решение человека (2026-10-28): по рекомендации.**
- [x] **Q-6. Правка спеки 001.** *(Claude, 2026-10-28)*
  Эстафета 001 удаляется, а `spec:check` требует тест на каждый AC спеки `done`. Варианты: **(а)** переписать тексты AC-001-11, -15, -19, -20, -26, -27 под новое поведение с пометкой «изменено спекой 022» и оставить тесты с теми же id (T-16); **(б)** пометить эти AC в 001 как заменённые критериями 022 и научить `spec:check` пропускать пометку `[superseded: AC-022-n]`.
  **Рекомендация — «а»:** без новой логики в `spec:check`, а 001 остаётся описанием текущей системы. Альтернатива «в» — оставить эстафету режимом агента без модели — противоречит YAGNI.
  **Решение человека (2026-10-28): «а».** → T-16.
- [x] **Q-7. Агент-вход ответил текстом без `finish`.** *(Claude, 2026-10-28)*
  Без правила агент уходит в `idle`, писать ему некому, рой ждёт `SWARM_TIMEOUT_MS` и падает с `swarm_timeout`, хотя ответ уже есть. Варианты: **(а)** текст агента-входа считать `finish`; **(б)** один раз напомнить про `finish`, повторный текст считать результатом; **(в)** оркестратор закрывает рой, когда все агенты в `idle` и сообщений в полёте нет.
  **Решение человека (2026-10-28): «б».** Чтобы не закрыть рой, пока вход ждёт ответов участников, напоминание срабатывает только при пустом `awaiting` (4.4, шаг 5) → REQ-022-19, AC-022-28, T-7a.

## 10. Журнал реализации

Заполняет агент.

| Дата | Ветка / коммит | Что сделано | Отклонения от спеки |
|---|---|---|---|
| 2026-10-28 | `spec/022-t1` | `ready` поставлен по команде человека, спека взята в работу. Этап — задача, ветка от свежей `main`, PR этапа в `main`. T-8 и T-9 выполняются раньше T-7: агенту роя нужны `ChatModel` и `AgentConfig` | порядок T-7 ↔ T-8, T-9 |
| 2026-10-28 | `spec/022-t1` | T-1: `PlatformModel`, `model` в `AgentDraft`, `ENTRY_AGENT_ID`, `agent.step`, `agent.idle`, `agent_failed` | `LlmCaller` перенесён из `llm.ts` в `swarm.ts`: `swarm.ts` импортирует `PlatformModel` из `llm.ts`, обратный импорт давал цикл модулей; публичный API `@swag/contracts` не изменился |
| 2026-10-28 | `spec/022-t2` | T-2: правила проекции 4.6, `model` и `steps` в `SwarmView`, пустые рёбра при создании роя | — |
| 2026-10-28 | `spec/022-t3` | T-3: правила 4.7 фейкового провайдера в `infra/llm/fake-provider/server.ts`, описаны в README `adapter-litellm` | неверная форма JSON после `__tool_calls__` трактована как «правило не срабатывает» (D-78) |
| 2026-10-28 | `spec/022-t4` | T-4: `runAgentLoop` и типы 4.2 в `agent-core/src/loop.ts`; тесты AC-022-3…11 со скриптовым `ChatModel` | — (`steps` растёт и при неуспешном вызове, `stop` — первый по порядку `tool_calls`, исключение `ChatModel.complete` не перехватывается: буква 4.2) |
| 2026-10-28 | `spec/022-t5` | T-5: обработчик `subscribeJson` может вернуть `Promise`, спан consumer ждёт его, сообщения по одному; тест AC-022-22 на NATS | — |
| 2026-10-28 | `spec/022-t6` | T-6: `systemPrompt`, `inboxMessage`, `swarmTools` в `agent-core/src/prompt.ts`; тесты AC-022-12, AC-022-14 | Сигнатуры в 4.5 не заданы: выбраны `systemPrompt(agent)`, `inboxMessage({from,text}, peers)`, `swarmTools(agent, send)`; `AgentPeer` и `PromptAgent` — в `prompt.ts` (иначе цикл импортов с `index.ts`, T-7 импортирует оттуда); `send_message` отдаёт `(to, text)` колбэку, `BusMessage` собирает T-7; `zod` в `agent-core` для проверки аргументов (по 4.5 «проверка Zod») |
| 2026-10-28 | `spec/022-t8` | T-8: `createOpenAiChatModel` и `OpenAiChatModelOptions` в `adapter-openai` по 4.3, тест AC-022-19 на `startFakeProvider` | `openai` 7.33.0 — последняя стабильная версия, опубликованная не позже 2026-10-14; 429 без `error.code` → `rate_limited` (буква 4.3 даёт `upstream_error`, AC-022-19 требует `rate_limited` от фейка без кода); `tool_calls` не `function` отбрасываются; исключение вне ошибок SDK → `invalid_response`; `model_not_found` — тест на подставной HTTP-сервер (фейк кодов не отдаёт) |
| 2026-10-28 | `spec/022-swarm-agent` | Группа T-9, T-7, T-7a, T-10, T-11, T-12, T-13 — через фича-ветку `spec/022-swarm-agent`: PR задач в неё, в конце — PR фича-ветки в `main` | — (причина группы: T-9 убирает `AGENT_NEXT` и `AGENT_STEP_DELAY_MS` из конфигурации, T-7 меняет зависимости агента — оболочка агента, оркестратор и сквозной тест AC-001-20 не работают до T-10…T-13) |
| 2026-10-28 | `spec/022-t9` | T-9: `AgentConfig` и `OrchestratorConfig` по 4.8, `AGENT_NEXT` и `AGENT_STEP_DELAY_MS` удалены, `.env.example` (корневой), тесты `config` (10 шт.), README, глоссарий | `AGENT_MAX_STEPS`/`AGENT_MAX_TOKENS` в агенте — целые ≥ 1 (как в оркестраторе); `AGENT_LLM_MAX_RETRIES` ≥ 0; `LLM_GATEWAY_TOKEN` в агенте — от 32 символов (как в оркестраторе и gateway); `AGENT_PEERS` — JSON `AgentPeer[]`, схема продублирована в `config`; `compose.yaml` и локальный `.env` (не в git) ещё содержат `AGENT_STEP_DELAY_MS` — правят T-12 |
| 2026-10-28 | `spec/022-t7` | T-7: агент роя по 4.4 в `agent-core/src/index.ts` вместо эстафеты: `AgentBus.subscribe` с обработчиком-`Promise`, `AgentConfigCore` и `AgentCoreDeps` по 4.4, история и `stepsDone` в замыкании, `agent.working`, `agent.step`, `agent.idle`, `agent.result`, `agent.failed` (`max_steps`, `model_error:<code>`), `agent_finished`; `Timers`, `stepDelayMs`, `agentNext` и очередь удалены; тесты AC-022-13, -15, -16, AC-001-19 (на ход входа), AC-016-6, -7 в `test/agent-core.test.ts`; README и глоссарий | (1) Шаг 5 алгоритма 4.4 не сделан, это T-7a: итог `text` сразу даёт `agent.idle`, точка расширения помечена комментарием в `publishOutcome`. (2) Лог хода — `turn finished` по 4.11, а не `message handled` из AC-016-6: AC-016-6 и AC-016-7 переписаны на новое имя, текст 016 не менялся. (3) Очередь сообщений ядра снята: последовательность ходов — у адаптера (REQ-022-14). (4) Ошибка обработчика не логируется ядром (`message failed` снят), уходит адаптеру, который пишет её в спан. (5) AC-001-19 проверяет ход входа `finish`, а не `AGENT_NEXT`; текст 001 переписывает T-16. (6) Часть AC-022-13 «второй ход начался после конца первого» в ядре не проверить: очереди нет, порядок задаёт адаптер — закрыта AC-022-22. Текст 016 (таблица 4.8, AC-016-6) — D-81. |
| 2026-10-28 | `spec/022-t7a` | T-7a: напоминание агенту-входу по 4.4 шаг 5 в `agent-core/src/index.ts`: множество `awaiting` (`send` добавляет `to`, приём сообщения от участника убирает `from`), при пустом `awaiting` и итоге `text` один дополнительный проход цикла с `ENTRY_REMINDER` (4.5, константа в `prompt.ts`), повторный `text` — `stopped` с `result = text`; тесты AC-022-28 (4 случая) в `test/agent-core.test.ts`; README, глоссарий | (1) `awaiting` убирается при приёме сообщения, до хода, а не после шага 5. (2) Повторный `text` после напоминания — `stopped` буквально по 4.4, даже если в этом проходе был `send_message`: трактовка на подтверждение в D-82. (3) `steps` в логе `turn finished` — сумма шагов хода по обоим проходам; без напоминания то же, что раньше. (4) `text: null` при повторном итоге уходит как `result: ''` (`agent.result.text` — `z.string()`). (5) AC-016-7: скрипту добавлен второй ответ модели, потому что `text` агента-входа без `awaiting` теперь даёт напоминание (REQ-022-19, MUST); ассерты логов не менялись. AC-001-19, AC-022-13, -15, -16 не менялись и зелёные. (6) Напоминание при нулевом остатке `maxSteps` даёт `max_steps`, как любой проход без шагов по 4.4 шаг 3. |
| 2026-10-28 | `spec/022-t10` | T-10: `apps/agent/src/start.ts` собирает `createOpenAiChatModel` (`adapter-openai`) с `LLM_GATEWAY_URL`, `LLM_GATEWAY_TOKEN`, `AGENT_LLM_*`, `caller` из `SWARM_ID`/`AGENT_ID`; `AgentCoreDeps` по 4.4 из 4.8 (`AGENT_MODEL`, `AGENT_PEERS`, `AGENT_ENTRY`, `AGENT_MAX_STEPS`, `AGENT_MAX_TOKENS`); эстафета убрана; `@swag/adapter-openai` в зависимостях и references `apps/agent`; тесты AC-016-11 и AC-022-24 (`test/turn.test.ts`, два случая: успех и ошибка модели с `AGENT_LLM_MAX_RETRIES=0`) на новом env; спан хода consumer, проверка заголовков шлюза; README | (1) `traceparent` берётся из `telemetry.currentTraceparent()`, а не из `telemetry.trace.currentTraceparent`: метод есть у `Telemetry`, в `TraceContext` его нет. (2) Модель в AC-022-24 — настоящий `adapter-openai` поверх локального HTTP-сервера с фиксированными ответами, а не `infra/llm/fake-provider`: тот не отдаёт маркер в `content` ответа с `tool_calls`. (3) `AGENT_MODEL` приводится к `ModelId` без проверки формата: `AgentConfig` проверяет только непустоту (как в T-9). (4) `run.test.ts` не менялся: баннер env не читает. |
| 2026-10-28 | `spec/022-t11` | T-11: `orchestrator-core` — env агента по 4.8 (`AGENT_MODEL`, `AGENT_PEERS`, `AGENT_ENTRY`, `AGENT_MAX_STEPS`, `AGENT_MAX_TOKENS`, `LLM_GATEWAY_TOKEN`, `TELEMETRY_FLUSH_TIMEOUT_MS`), `AGENT_NEXT` и `AGENT_STEP_DELAY_MS` удалены; итог роя только от `ENTRY_AGENT_ID`, `agent.failed` в `running` → `swarm.failed agent_failed` с `detail`; тесты AC-001-11, AC-001-15 переписаны, AC-022-17, AC-022-18 добавлены; README | (1) `TRACEPARENT` ядро не ставит — противоречие 4.8 и 016 AC-016-10, D-83. (2) `deps.agent` — `{template, maxSteps, maxTokens, llmGatewayToken, flushTimeoutMs}` вместо `stepDelayMs`; `apps/orchestrator` и тест `apps/orchestrator/test/health.test.ts` ломаются до T-12. (3) AC-001-11 без проверки env: env по 4.8 проверяет AC-022-17. |
| 2026-10-28 | `spec/022-t12` | T-12: `adapter-docker` ставит `LLM_GATEWAY_URL` из опции `llmGatewayUrl` (`DOCKER_AGENT_LLM_GATEWAY_URL`), тест AC-022-17 в `test/docker.test.ts` (настоящий Docker); `apps/orchestrator`: `deps.agent` по 4.9 из конфигурации, адрес gateway в адаптер, `AGENT_STEP_DELAY_MS` убран; `compose.yaml`: env `AGENT_MAX_STEPS`, `AGENT_MAX_TOKENS`, `LLM_GATEWAY_TOKEN`, `DOCKER_AGENT_LLM_GATEWAY_URL`, `depends_on: llm-gateway (service_healthy)`; тесты `health.test.ts` и `trace.test.ts` на новых полях с фейковым токеном; READMEs `adapter-docker`, `apps/orchestrator`, корневой | (1) Сеть: агенты в `DOCKER_AGENT_NETWORK=swag_default`, `llm-gateway` уже в `default` — сеть compose не менялась. (2) `llm-gateway` имеет healthcheck, цикла зависимостей нет. (3) `.env` (не в git) — добавлены три ключа из `.env.example`, удалён `AGENT_STEP_DELAY_MS`; без этого оркестратор не поднимется локально. (4) `apps/api/test/e2e.test.ts` — T-13, `typecheck` падает только там. |
| 2026-10-28 | `spec/022-t13` | T-13: `apps/api/test/e2e.test.ts` — сквозной тест AC-022-21 (`it` с ids `AC-022-21, AC-001-20`) на скриптовых моделях, эстафета (`agentNext`, `stepDelayMs`, таймеры) убрана; AC-016-12 и AC-016-13 переведены на тот же рой; песочница-фейк разбирает env через `loadConfig(AgentConfig)`; README `apps/api` | (1) Адаптерные ключи `NATS_URL`, `LLM_GATEWAY_URL` в фейке подставляются константами: оркестратор их не ставит (4.8). (2) Скриптовая модель локальная в тесте: `scripted` из `agent-core/test` не экспортируется. (3) Агент без участников в фейке не отвечает: AC-016-12 останавливает одиночный рой. (4) `apps/api/package.json` не объявляет `@swag/agent-core` и `@swag/orchestrator-core` — импорты теста были такими до T-13, не менялось. |
| 2026-10-28 | `spec/022-t14` | T-14: `ui-core` — `formatAgentStep(data)` по 4.10; выбор модели в форме уже обеспечен `AgentDraft.model` (`validateForm` → `SwarmsApi.create`), без `model` уходит `chat-small`; фикстура `swarm.created` приведена к 4.1 (у агентов есть `model`); тесты AC-022-23 в `test/ui-core.test.ts` и `test/format-agent-step.test.ts`; README `ui-core`, глоссарий | — |
| 2026-10-28 | `spec/022-t15` | T-15: `apps/ui/cabinet` — выбор модели в форме из `PlatformModel.options` (`@swag/contracts`), по умолчанию `chat-small`, уходит в `AgentDraft.model`; `agent.step` в ленте через `formatAgentStep`; граф по 4.10 в `swarm-graph.ts`: узлы по кругу в порядке id, встречные рёбра — дуги внутрь круга на разную глубину (после ревью: наружу дуга заходила под соседний узел при 5+ агентах), петли наружу, чистые функции `layoutNodes`/`edgePath`; в узле модель и число шагов; подсказка формы и комментарии без слов «цепочка»/«эстафета»; README кабинета; `npm run build` зелёный. Ручная проверка AC-022-25 — в T-17, здесь не делалась | (1) В кабинете нет тестового раннера и тестов — тест геометрии не заведён (правило «не заводить инфраструктуру»). (2) `agent.idle` в ленте — без строки (как прочие события без формата). (3) Дуги рисуются для пары встречных рёбер; одиночное ребро — прямая, даже если соседний узел лежит «в стороне» |
| 2026-10-28 | `spec/022-t16` | T-16: правка спеки 001 по Q-6 — 4.7.1, 4.7.2 и AC-001-11, -15, -19, -20, -26, -27 переписаны под агентный цикл с сохранением id и пометкой «Изменено спекой 022 (Q-6)»; AC-001-27 заменён AC-022-27. Записано в журнал 001. README пакетов `agent-core`, `apps/agent`, `orchestrator-core`, `adapter-docker`, `adapter-nats`, `api-integration`, `ui-core`, `cabinet`, `contracts`, `config` и корневой README сверены с кодом; устаревшие формулировки про цепочку, порядок агентов и env эстафеты исправлены в корневом README и README `orchestrator-core`. Фейкового провайдера README нет (`infra/llm/fake-provider/server.ts` без README). | Трактовка: AC-001-20 описан по сценарию AC-022-21 (тот же тест). Остальные места 001 вне Q-6 не менялись. |
| 2026-10-28 | `spec/022-t17` | T-17: ручные проверки на `npm run up` (Windows, Docker Desktop). **AC-022-25** (`LLM_PROFILE=test`, UI): рой «Автор»/«Редактор», задача собрана `JSON.stringify`: `__tool_calls__[{"name":"send_message","arguments":{"to":"agent-2","text":"привет агенту-2 __tool_calls__[{\"name\":\"send_message\",\"arguments\":{\"to\":\"agent-1\",\"text\":\"ответ агенту-1 __tool_calls__[{\\\"name\\\":\\\"finish\\\",\\\"arguments\\\":{\\\"result\\\":\\\"итог роя\\\"}}]\"}}]"}}]` — рой `completed`, результат «итог роя»; лента: 28 событий, строки шагов (`шаг 1 → send_message`, `шаг 2: fake reply`, `шаг 3 → finish`), `bus.message` в обе стороны, 6 × `llm.call` `chat-small · 1000 (кэш 200) → 500 ток. · $0.009960`; граф — две дуги `agent-1 → agent-2` и `agent-2 → agent-1` по «1 сообщ.» (SVG: `M 275 170 Q 255 250 275 330`, `M 245 330 Q 165 250 245 170`); `docker ps -a --filter label=swag.kind` пуст. **AC-022-27** (`test`): задача «по кругу» из трёх вложенных `send_message` без `finish` — рой `running`, оба агента «ждёт» после 4 шагов; «Стоп» → `agent.stopped` × 2, `swarm.stopped`, рой и агенты `stopped`, контейнеров 0. **AC-022-26** (`LLM_PROFILE=dev`, OpenRouter free, UI): рой `completed` за 18,3 с до `SWARM_TIMEOUT_MS`, результат — четверостишие, `costMicroUsd: 0`; «Трейс» из события ведёт в Grafana Explore (Tempo), в трейсе 50 спанов: `agent: process swarm.{swarmId}.agent.{agentId}.inbox` (ход агента) → `llm-gateway: POST` → `litellm.chat`. **NFR-022-2** (`dev`, 3 прогона): 1 — 18,3 с, шагов 1 (вход сразу `finish`, «Редактор» не участвовал), 1 вызов модели; 2 — 85,1 с, шагов 3 + 2, 5 вызовов, рёбра 1→2 и 2→1, результат — четверостишие; 3 — 60,4 с, шагов 4 + 2, 6 вызовов, результат пустой (D-85). Стоимость всех вызовов 0. Сценарий S-3 — статус «ручной». | Скриншоты не сняты: окно приложения было свёрнуто, браузерная панель не отрисовывала кадр — вместо них текст страницы, SVG и вывод API выше. Наблюдения: фейковый провайдер 002 на сообщение без маркера при наличии инструментов вызывает первый инструмент с `{}` — агент отклоняет его как ошибку аргументов, сообщения в шину нет (видно в AC-022-27: `шаг 3 → send_message` без `bus.message`); OpenRouter маршрутизирует `chat-small` на разных провайдеров — число токенов промпта между шагами не монотонно. Прогон 1: модель входа завершила рой, не отдав текст «Редактору» — по букве AC-022-26 это проходит, сценарий S-3 подразумевает совместную работу. |
| 2026-10-28 | `spec/022-t17` | Завершение: `npm run check` зелёный (369 тестов, 6 пропущены без NATS/Docker-окружения тестов, `spec:check` — у всех критериев есть тесты); **NFR-022-1**: `npm test` — 6,25 с (порог 60 с); README затронутых пакетов сверены в T-16; статус `review`. На приёмку: D-78…D-85 в `questions.md` (куда — приёмка 022); техдолг N-11…N-13 в `notes.md` | — |
| 2026-10-29 | `spec/022-acceptance` | T-18: `ChatModelErrorCode` + `max_tokens` (4.2); `adapter-openai` — `finish_reason: 'length'` → `max_tokens` даже с текстом или `tool_calls` (4.3, D-85); агент-вход после напоминания по шагу 5 4.4: при непустом `awaiting` — `agent.idle` (D-82), при пустом или `null` тексте — `agent.failed` `empty_result` (D-85), иначе `agent.result`; локальный `TurnOutcome` в `index.ts`, `loop.ts` не менялся; `agent.failed.reason` в `contracts` — свободная строка, схема не менялась; тесты AC-022-19 (2 новых), AC-022-16 (`max_tokens`), AC-022-28 (3 новых); README обоих пакетов, глоссарий | Отклонений от буквы 4.4 нет. Локальный тип `TurnOutcome` и функция `afterReminder` в `index.ts` — вариант, который 4.4 разрешает; `AgentLoopResult` не менялся. Вместо `text: null → result: ''` (T-7a, пункт 4) пустой итог теперь `empty_result`. |
| 2026-10-29 | `spec/022-acceptance` | T-19: тексты по решениям приёмки. D-81: 016, таблица 4.8 и AC-016-6 — лог `turn finished` (`messageId`, `kind`, `steps`) вместо `message handled`, пометка «изменено спекой 022»; других упоминаний в 016 нет, id и тесты не менялись. D-84 «б»: 001 — REQ-001-1 и REQ-001-11 (агент-вход, участники, ход вместо эстафеты, завершение и падение по REQ-022-11), правило рёбер 4.4 (рёбра по фактическим сообщениям, `edges` пуст при создании, статус агента при `bus.message` не меняется), граф и форма 4.8, строка `AGENT_STEP_DELAY_MS` удалена из таблицы 4.9; `.env.example` и `packages/config` ключа не содержат. Разделы 1–2, 6–7, задачи, вопросы и журнал 001 не менялись | Отклонений от букв D-81 и D-84 нет. REQ-001-9 дополнен завершением по агенту-входу и падением `agent_failed`; REQ-001-8 (задача первому агенту) верен и не менялся. |
