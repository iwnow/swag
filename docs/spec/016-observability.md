---
id: "016"
title: Наблюдаемость
status: in-progress
roadmap_stage: 1а
depends_on: ["001"]
superseded_by: null
updated: 2026-10-22
---

# 016. Наблюдаемость

> **Коротко.** Каждый рой можно проследить от запроса пользователя до сбоя: что происходило, в каком сервисе и почему упало.
> - **Что появится.**
>   - У роя есть трейс OpenTelemetry. Он начинается на `POST /swarms` в `api` и проходит через HTTP-вызов оркестратора, создание песочниц, старт агентов и каждое сообщение NATS.
>   - Контекст передаётся так: в HTTP — заголовком `traceparent`, в NATS — заголовком сообщения, в песочницу — переменной `TRACEPARENT`.
>   - В конверте каждого события платформы есть `traceId`. В ленте UI у события есть ссылка «Трейс», она открывает трейс в Grafana.
> - **Логи.** `api`, `orchestrator` и агент пишут JSON-логи одной схемы `LogRecord` с полями `traceId`, `spanId`, `swarmId`, `agentId` и `err`. Логи уходят и в stdout (`docker compose logs`), и по OTLP. Порт `Logger` в ядрах получает уровни `debug`, `info`, `warn`, `error`, но OpenTelemetry ядра по-прежнему не видят.
> - **Сбор.** В compose появляются OpenTelemetry Collector и `grafana/otel-lgtm` (Tempo, Loki, Grafana). Grafana открыта только на `127.0.0.1`. Сервисы и агенты шлют телеметрию только в Collector.
> - **Новые пакеты.** `adapter-telemetry`: инициализация SDK, логгер на pino, порт `TraceContext`, перенос контекста. `adapter-nats` и `adapter-docker` начинают передавать контекст.
> - **Главная проверка.** Агенты не могут подключиться к NATS, рой падает на старте. В Grafana по `traceId` из события `swarm.failed` видна вся цепочка, а в логе агента — ошибка с причиной.
> - **Из бэклога** забран D-12, он разложен на Q-2…Q-5. Вопросы для 005 и 014 возвращены в бэклог как D-14 и D-15, модель трейса долгих роёв — D-13 для 002.
> - **Решения человека (Q-1…Q-7):**
>   - `traceId` рождается в оболочке на триггере; ядро получает его через обязательный порт `TraceContext` и только переносит в конверт события;
>   - логи — pino;
>   - отдельный Collector перед `otel-lgtm`, семплирование 100%, NFR-016-1 без порога;
>   - в логах и спанах только id, числа и длины, без пользовательского текста;
>   - ссылка «Трейс» — относительная, через прокси `/grafana`;
>   - трейс начинается в `api`, без SDK в браузере.
>
>   Открытых вопросов нет, спека ждёт статуса `ready` от человека.

## 1. Контекст и цель

Этап 1а [роадмапа](../../AI_PLATFORM_ROADMAP.md#этапы) и раздел [7 «Наблюдаемость»](../../AI_PLATFORM_ROADMAP.md#7-наблюдаемость), принцип 9. Правила для кода — в [architecture.md](../architecture.md#наблюдаемость-traceid-логи-трейсы).

**Сейчас (после 001).** Порт `Logger` в ядрах умеет только `warn`. Оболочки пишут `console.warn(JSON.stringify(...))`, а Fastify — свой лог pino в другом формате. Связи между записями разных сервисов нет. Если рой упал на старте агента, видно только `swarm.failed` с `agent_start_timeout`: почему агент не стартовал, приходится искать по `docker logs` контейнера, а оркестратор его уже удалил.

**Цель.** Один `traceId` на рой, который проходит через все сервисы, шину и песочницы. Структурные логи одной схемы, привязанные к трейсу. Трейсы и логи лежат в одной Grafana, а из события в UI можно перейти в его трейс. Всё это закладывается до LLM (002): с моделью сбоев станет больше, и разбирать их надо уже с трейсами.

## 2. Объём

**Входит:**
- `traceId` в конверте событий платформы (4.1), схема `LogRecord` в `@swag/contracts` (4.2);
- порты `Logger` (четыре уровня) и `TraceContext` в `api-core`, `orchestrator-core` и `agent-core` (4.3);
- пакет `packages/adapter-telemetry`: инициализация OpenTelemetry SDK в оболочке, логгер, `TraceContext`, перенос контекста через `traceparent` и `TRACEPARENT`, сброс телеметрии при остановке (4.4);
- перенос контекста в HTTP `api` → `orchestrator` (4.5), в `adapter-nats` (4.6) и в `adapter-docker` (4.7);
- оболочки `api`, `orchestrator` и `agent` переходят на единый логгер (Fastify — тоже), ядра пишут логи из 4.8;
- `compose.yaml`: сервисы `otel-collector` и `lgtm`, конфигурация Collector в репозитории, `infra:check` для обоих (4.9);
- UI: ссылка «Трейс» у события в ленте (4.10);
- README затронутых пакетов, корневой README (как открыть Grafana), раздел наблюдаемости в `architecture.md`, если реализация уточнит правила.

**Не входит** (агент это не делает, даже если кажется логичным):
- метрики, Prometheus, cAdvisor, алерты, `docker events` — этап 16 роадмапа;
- телеметрия LLM-вызовов (`llm.call`, спаны модели), Langfuse — спека 002 и дальше. 016 даёт для них механизм, но сами спаны не вводит;
- события `tool.call` и `budget.exceeded` — спеки 002, 004, 008;
- хранение событий и `traceId` в Postgres — спека 003. В 016 события, как и раньше, живут в памяти `api`;
- доступ к Grafana по ролям (пользователь, администратор организации, супервизор), вход в Grafana — спеки 012 и 014. В 016 Grafana локальная, без входа, только на `127.0.0.1`;
- закрытая сеть песочницы и путь телеметрии из неё к Collector — спека 005 (см. Q-5). В 016 агент в общей сети compose, как в 001;
- семплирование и сроки хранения для сервера, деплой Grafana LGTM вне compose (см. Q-3);
- OpenTelemetry SDK в браузере и спаны UI (см. Q-7);
- трейс для потока WebSocket: кадры потока не трассируются, `traceId` уже есть в самих событиях;
- изменение событий, статусов и поведения роя из 001: 016 добавляет телеметрию, а сценарий роя не меняет.

## 3. Требования

| ID | Требование | Приоритет |
|---|---|---|
| REQ-016-1 | Конверт каждого события платформы MUST содержать поле `traceId` по 4.1. Источник значения — порт `TraceContext` того ядра, которое строит событие (по Q-1). Событие, полученное из шины, `api` MUST хранить и отдавать с тем `traceId`, с которым его опубликовали. | MUST |
| REQ-016-2 | Один рой MUST давать один трейс от `POST /swarms` до завершения роя. В нём: HTTP-запрос к `api`, вызов оркестратора, создание каждой песочницы, старт каждого агента, каждое сообщение и событие NATS, события по таймерам оркестратора (таймауты). У всех событий роя, кроме вызванных отдельным запросом пользователя («Стоп»), `traceId` равен `traceId` запроса `POST /swarms`. Событиям «Стоп» соответствует трейс запроса `POST /swarms/:id/stop`. | MUST |
| REQ-016-3 | Контекст трассировки MUST передаваться в формате W3C Trace Context: в HTTP — в заголовке `traceparent`, в NATS — в заголовке сообщения `traceparent`, в песочницу — в env `TRACEPARENT`. Если входящего контекста нет, MUST начинаться новый трейс. Невалидный `traceparent` MUST игнорироваться (новый трейс) без ошибки запроса. | MUST |
| REQ-016-4 | Ядра MUST NOT зависеть от OpenTelemetry и pino. Логи они пишут через порт `Logger` с контекстом, `traceId` получают только через порт `TraceContext` (4.3). `arch:check` MUST это ловить так же, как остальные запреты. | MUST |
| REQ-016-5 | `api`, `orchestrator` и агент MUST писать все логи, в том числе логи Fastify и ошибки старта, одной схемой `LogRecord` (4.2): одна JSON-строка на запись в stdout. Внутри активного спана поля `traceId` и `spanId` MUST быть заполнены. | MUST |
| REQ-016-6 | Логи и трейсы MUST отправляться по OTLP в OpenTelemetry Collector, адрес задаётся `OTEL_EXPORTER_OTLP_ENDPOINT`. Если переменная пуста, сервис MUST работать только с логами в stdout, без экспорта. | MUST |
| REQ-016-7 | Недоступный Collector MUST NOT ломать сервис и рой: экспорт идёт в фоне, ошибки экспорта не попадают в ответы API и не роняют процесс. | MUST |
| REQ-016-8 | При штатной остановке (`SIGTERM`) и при выходе с ошибкой старта процесс MUST отправить накопленную телеметрию, ожидая не дольше `TELEMETRY_FLUSH_TIMEOUT_MS` (4.11). Так последний лог упавшего агента доходит до Loki. | MUST |
| REQ-016-9 | Ядра MUST писать логи из таблицы 4.8 на указанных уровнях, с `swarmId` и `agentId`, где они есть. Ошибка передаётся в поле `err`, а не текстом в `msg`. | MUST |
| REQ-016-10 | Логи и атрибуты спанов MUST NOT содержать секретов и env песочницы целиком. Пользовательский текст (задача, роли, тексты сообщений и результат) — по ответу на Q-4. | MUST |
| REQ-016-11 | `compose.yaml` MUST поднимать `otel-collector` и `lgtm` вместе с остальными сервисами в `npm run up` и `npm run dev`. Конфигурация Collector лежит в репозитории. Grafana публикуется только на `127.0.0.1:${GRAFANA_PORT}`, порты Collector, Tempo и Loki не публикуются. `infra:check` MUST проверять оба сервиса. | MUST |
| REQ-016-12 | В Grafana из записи лога Loki MUST открываться трейс по `traceId`, а из спана Tempo — логи этого трейса. | MUST |
| REQ-016-13 | В ленте событий UI у события с `traceId` MUST быть ссылка «Трейс», которая открывает трейс в Grafana (адрес — по Q-6). Логика построения ссылки — в `ui-core`. | MUST |
| REQ-016-14 | Сервисам песочницы MUST передаваться только адрес Collector (`OTEL_EXPORTER_OTLP_ENDPOINT`) и `TRACEPARENT`. Адресов Grafana, Tempo и Loki агент не получает. | MUST |
| REQ-016-15 | Спаны SHOULD называться и размечаться по семантическим соглашениям OpenTelemetry (HTTP, messaging) с атрибутами `swarm.id` и `agent.id`, где они известны. | SHOULD |

## 4. Контракты

### 4.1. `traceId` в конверте событий — `packages/contracts/src/events.ts`

```ts
export const TraceId = z.string().regex(/^[0-9a-f]{32}$/).refine((v) => v !== '0'.repeat(32)); // W3C trace-id

const Envelope = {
  id: z.uuid(),
  swarmId: SwarmId,
  ts: z.iso.datetime(),
  source: z.enum(['api', 'orchestrator', 'agent']),
  agentId: AgentId.nullable(),
  traceId: TraceId.nullable(),        // новое: null — событие построено вне трейса
};
```

Остальное в 4.3 спеки 001 не меняется. `null` допустим, чтобы событие без контекста (например, в тесте без SDK) не отбрасывалось. В работающей системе по REQ-016-2 он не ожидается, и AC-016-12 это проверяет.

### 4.2. Схема лога — `packages/contracts/src/log.ts`

```ts
export const LogLevel = z.enum(['debug', 'info', 'warn', 'error']);
export const ServiceName = z.enum(['api', 'orchestrator', 'agent']);

export const LogError = z.strictObject({
  type: z.string(),                   // имя класса ошибки: Error, ConfigError, NatsError…
  message: z.string(),
  stack: z.string().optional(),
  cause: z.string().optional(),       // message причины (error.cause), если есть
});

export const LogRecord = z.looseObject({ // лишние поля допустимы: req, res, responseTime от Fastify
  time: z.iso.datetime(),
  level: LogLevel,
  service: ServiceName,
  msg: z.string(),
  traceId: TraceId.optional(),        // есть, если запись сделана внутри спана
  spanId: z.string().regex(/^[0-9a-f]{16}$/).optional(),
  swarmId: SwarmId.optional(),
  agentId: AgentId.optional(),
  err: LogError.optional(),
});
```

В записи нет полей pino по умолчанию (`pid`, `hostname`, числового `level`). Уровень — строкой.

### 4.3. Порты ядер

Объявляются в каждом ядре, которому нужны: `api-core`, `orchestrator-core`, `agent-core`. Это правило 001 4.5.4.

```ts
export type LogContext = {
  swarmId?: string;
  agentId?: string;
  err?: unknown;                      // адаптер превращает в LogError
  [key: string]: unknown;             // прочие поля — только id, числа, перечисления (REQ-016-10)
};
export interface Logger {
  debug(msg: string, ctx?: LogContext): void;
  info(msg: string, ctx?: LogContext): void;
  warn(msg: string, ctx?: LogContext): void;
  error(msg: string, ctx?: LogContext): void;
}

/** Текущий контекст трассировки. Ядро кладёт значение в конверт события, не разбирая его. */
export interface TraceContext {
  currentTraceId(): string | null;    // null — вне трейса
}
```

Порт `TraceContext` добавляется в `ApiCoreDeps`, `OrchestratorCoreDeps` и в зависимости `agent-core` как обязательное поле `trace` (Q-1).

`traceId` рождается в оболочке на триггере: входящий запрос без `traceparent` начинает новый трейс. События платформы — следствия триггера и несут его `traceId`. Правило `architecture.md`, «Наблюдаемость», п. 1, уточняется: ядро не создаёт и не интерпретирует `traceId`, не знает OpenTelemetry, а значение получает через `TraceContext` и переносит в конверт события как непрозрачную строку.

### 4.4. `packages/adapter-telemetry`

Пакет оболочек. Его импортируют только `apps/*` и адаптеры, ядра — никогда.

```ts
export interface TelemetryOptions {
  service: ServiceName;
  version: string;
  otlpEndpoint: string | null;        // OTEL_EXPORTER_OTLP_ENDPOINT; null — без экспорта (REQ-016-6)
  logLevel: LogLevel;                 // LOG_LEVEL
  flushTimeoutMs: number;             // TELEMETRY_FLUSH_TIMEOUT_MS
  stdout?: (line: string) => void;    // для тестов; по умолчанию process.stdout
}
export interface Telemetry {
  logger: Logger & { pino: PinoLogger }; // pino — для Fastify (loggerInstance)
  trace: TraceContext;
  /** Выполнить fn в спане; parent — из traceparent (заголовок, env) или из активного контекста. */
  inSpan<T>(name: string, opts: { parent?: string | null; kind?: 'server' | 'client' | 'producer' | 'consumer' | 'internal'; attributes?: Record<string, string | number> }, fn: () => T): T;
  currentTraceparent(): string | null;   // для передачи дальше: заголовок, env
  shutdown(): Promise<void>;          // сброс и остановка, не дольше flushTimeoutMs
}
export function startTelemetry(options: TelemetryOptions): Telemetry;
```

- Контекст хранится в `AsyncLocalStorage` (context manager OpenTelemetry для Node). Поэтому `currentTraceId()` верен и в колбэках таймеров, и в обработчиках, запущенных внутри спана.
- Логгер — по Q-2, рекомендация — pino. Пишет `LogRecord` в stdout и, если есть `otlpEndpoint`, в OTLP Logs. `err` из `LogContext` превращается в `LogError`.
- Пропагатор — W3C Trace Context. Невалидный `traceparent` даёт новый трейс (REQ-016-3).
- Семплер — `parentbased_always_on` (по Q-3).
- Версии `@opentelemetry/*` и pino — последние стабильные на момент реализации, записываются в журнал и README пакета.

### 4.5. HTTP

- `api` и `orchestrator` принимают `traceparent` во входящем запросе. Серверный спан запроса — потомок этого контекста или корень нового трейса.
- `adapter-orchestrator-http` вызывает оркестратор внутри клиентского спана и передаёт `traceparent` текущего контекста. Способ — автоинструментация `fetch` или явная передача заголовка; выбор агента с записью в журнал.
- Ответы API не меняются. Заголовок `traceparent` в ответ не добавляется.

### 4.6. NATS — `packages/adapter-nats`

- Публикация JSON выполняется в спане `kind: producer` и кладёт в заголовки сообщения `traceparent` текущего контекста. Тело сообщения не меняется.
- Подписка вызывает обработчик внутри спана `kind: consumer`. Его родитель — `traceparent` из заголовков, без заголовка — новый трейс.
- Атрибуты спанов: `messaging.system=nats`, `messaging.destination.name=<subject>`; `swarm.id` и `agent.id` — разбором subject из 4.2 спеки 001.
- Адаптер зависит только от `@opentelemetry/api`. Без SDK это no-op, тесты адаптера без телеметрии работают как раньше.

### 4.7. Песочница — `packages/adapter-docker`, `apps/agent`

- Docker-адаптер добавляет в env песочницы, вместе с `NATS_URL`:
  - `TRACEPARENT` — текущий контекст на момент `create`;
  - `OTEL_EXPORTER_OTLP_ENDPOINT` — из своей конфигурации `DOCKER_AGENT_OTLP_ENDPOINT`.

  `SandboxSpec` от ядра не меняется.
- `create` и `remove` выполняются в спанах `sandbox.create` и `sandbox.remove` с атрибутами `swarm.id`, `agent.id` и `sandbox.id` (после создания).
- `AgentConfig` получает две необязательные переменные: `TRACEPARENT` и `OTEL_EXPORTER_OTLP_ENDPOINT`. Пустые строки означают, что значения нет.
- Оболочка агента поднимает телеметрию до подключения к NATS. Старт идёт в спане `agent.start`, его родитель — `TRACEPARENT`. В этом спане агент подключается к NATS, подписывается и публикует `agent.started`. Ошибка конфигурации или подключения:
  1. `error`-лог с `err`;
  2. `shutdown()` телеметрии (REQ-016-8);
  3. выход с кодом 1.

### 4.8. Что пишут ядра

| Ядро | Когда | Уровень | `msg` | Контекст |
|---|---|---|---|---|
| `api-core` | рой создан | `info` | `swarm created` | `swarmId`, `agents` (число) |
| `api-core` | оркестратор недоступен | `error` | `orchestrator unavailable` | `swarmId`, `err` |
| `api-core` | событие или сообщение отброшено (001 REQ-001-6) | `warn` | `event dropped` / `message dropped` | `swarmId` (если разобран), `reason` |
| `orchestrator-core` | запуск роя | `info` | `swarm launch` | `swarmId`, `agents` |
| `orchestrator-core` | ошибка `create` | `error` | `sandbox create failed` | `swarmId`, `agentId`, `err` |
| `orchestrator-core` | таймаут старта | `error` | `agent start timeout` | `swarmId`, `missing` (id агентов без `agent.started`) |
| `orchestrator-core` | таймаут роя | `error` | `swarm timeout` | `swarmId` |
| `orchestrator-core` | рой завершён | `info` | `swarm finished` | `swarmId`, `status` |
| `orchestrator-core` | ошибка `remove` при уборке | `warn` | `sandbox remove failed` | `swarmId`, `agentId`, `err` |
| `agent-core` | старт | `info` | `agent started` | `swarmId`, `agentId` |
| `agent-core` | сообщение обработано | `debug` | `message handled` | `swarmId`, `agentId`, `messageId`, `from` |

Текст задачи, ролей, сообщений и результата в контекст не попадает (рекомендация Q-4). Остальные логи — на усмотрение агента, по тем же правилам.

### 4.9. Compose и `infra:check`

| Сервис | Образ | Порты | Назначение |
|---|---|---|---|
| `otel-collector` | `otel/opentelemetry-collector-contrib:<версия>` (по Q-3) | не публикуются; в сети compose — OTLP HTTP `4318` | приём OTLP от сервисов и агентов, отправка в `lgtm` |
| `lgtm` | `grafana/otel-lgtm:<версия>` | `127.0.0.1:${GRAFANA_PORT}:3000` | Tempo, Loki, Grafana; источники данных и связь «лог ↔ трейс» настроены |

- Конфигурация Collector — `infra/otel-collector.yaml`: receiver `otlp` (http), processor `batch`, exporter в `lgtm` по OTLP. Смена бэкенда — правка этого файла (architecture.md).
- Данные `lgtm` — volume `lgtm-data`.
- `api`, `orchestrator` и `ui` зависят от `otel-collector` (`service_started`). Агент получает адрес через `DOCKER_AGENT_OTLP_ENDPOINT`.
- `infra:check`:
  - `grafana` — `GET http://127.0.0.1:${GRAFANA_PORT}/api/health` → 200;
  - `otel-collector` — проверка изнутри контейнера, как у оркестратора (Q-7 спеки 001). Способ (`health_check` extension или запрос к OTLP) — выбор агента с записью в журнал.
- Версии образов — точные теги, последние стабильные на момент реализации, в журнал.

### 4.10. UI

- `ui-core` получает функцию `traceUrl(traceId: string | null): string | null`. Шаблон адреса передаётся в зависимостях ядра (`traces: { urlTemplate: string }`) и содержит подстановку `{traceId}`. Без `traceId` функция возвращает `null`.
- `apps/ui/cabinet`: в ленте у события с `traceId` есть ссылка «Трейс» (`target="_blank"`, `rel="noopener"`). Источник шаблона — по Q-6.
- Точный формат URL Explore Grafana для Tempo по `traceId` агент подбирает под выбранную версию `lgtm`, записывает в журнал и проверяет в AC-016-17.

### 4.11. Переменные окружения

| Переменная | Сервис | Пример в `.env.example` | Назначение |
|---|---|---|---|
| `OTEL_EXPORTER_OTLP_ENDPOINT` | `api`, `orchestrator`; агент — от оркестратора | `http://otel-collector:4318` | куда слать OTLP; пусто — без экспорта |
| `LOG_LEVEL` | `api`, `orchestrator` | `info` | минимальный уровень логов |
| `TELEMETRY_FLUSH_TIMEOUT_MS` | `api`, `orchestrator`, агент | `2000` | ожидание сброса телеметрии при остановке |
| `DOCKER_AGENT_OTLP_ENDPOINT` | `orchestrator` (Docker-адаптер) | `http://otel-collector:4318` | адрес Collector изнутри песочницы |
| `GRAFANA_PORT` | `lgtm`, `infra:check` | `3300` | порт Grafana на `127.0.0.1` |

Схемы в `@swag/config`:
- `BaseConfig` получает `OTEL_EXPORTER_OTLP_ENDPOINT` (необязательная, пустая строка — `null`), `LOG_LEVEL` (`LogLevel`, по умолчанию `info`) и `TELEMETRY_FLUSH_TIMEOUT_MS` (по умолчанию `2000`);
- `OrchestratorConfig` получает `DOCKER_AGENT_OTLP_ENDPOINT`;
- `AgentConfig` получает переменные из 4.7 и `TELEMETRY_FLUSH_TIMEOUT_MS` (по умолчанию `2000`). Уровень логов агента — `info`, оркестратор его не передаёт;
- новая схема `ObservabilityConfig` — `GRAFANA_PORT` для `infra:check`.

### 4.12. Пакеты

| Пакет | Что | Зависимости |
|---|---|---|
| `packages/adapter-telemetry` | 4.4: SDK, логгер, `TraceContext`, `inSpan`, `shutdown` | `@opentelemetry/*`, pino (по Q-2), `@swag/contracts` |
| `packages/adapter-nats` | + перенос контекста 4.6 | + `@opentelemetry/api` |
| `packages/adapter-docker` | + `TRACEPARENT`, `OTEL_EXPORTER_OTLP_ENDPOINT`, спаны 4.7 | + `@opentelemetry/api` |
| `packages/adapter-orchestrator-http` | + `traceparent` в запросе 4.5 | + `@opentelemetry/api` (если не автоинструментация) |

## 5. Критерии приёмки

- **AC-016-1** — *Given* схемы `contracts`, *When* разбор, *Then*:
  - событие с `traceId` из 32 hex-символов в нижнем регистре проходит, с `null` — проходит;
  - `traceId` из нулей, длины 31, с заглавными буквами или без поля — ошибка;
  - `LogRecord` с полями 4.2 и лишним полем `req` проходит, с `level: 30` или без `service` — ошибка.
- **AC-016-2** — *Given* `adapter-telemetry` без экспорта, с перехватом stdout, *When*:
  - запись вне спана;
  - запись внутри `inSpan` с `swarmId`, `agentId` и `err` (ошибка с `cause`);
  - запись уровня ниже `LOG_LEVEL`,

  *Then* каждая выведенная строка — JSON, проходящий `LogRecord`. Вне спана `traceId` нет, внутри — `traceId` и `spanId` активного спана. `err` содержит `type`, `message`, `stack` и `cause`. Запись ниже уровня не выведена.
- **AC-016-3** — *Given* `adapter-telemetry`, *When* `inSpan` с `parent` из валидного `traceparent`, с невалидным и без него, *Then*:
  - с валидным — `currentTraceId()` равен trace-id из `traceparent`;
  - с невалидным и без него — новый ненулевой `traceId`, без исключения;
  - `currentTraceparent()` внутри спана содержит тот же `traceId`;
  - в колбэке `setTimeout`, запланированном внутри спана, `currentTraceId()` тот же.
- **AC-016-4** — *Given* `api-core` с фейковым `TraceContext` (`T1`), *When*:
  - `createSwarm`;
  - `createSwarm` при ошибке оркестратора;
  - `ingestMessage` при `T2`;
  - `ingestEvent` события с `traceId: T3`,

  *Then* `swarm.created` и `swarm.failed` несут `T1`, `bus.message` — `T2`, сохранённое событие — `T3`, даже если текущий контекст другой.
- **AC-016-5** — *Given* `orchestrator-core` с фейковым `TraceContext`, *When* `launch`, затем таймаут старта (ручные таймеры), *Then* все опубликованные события (`agent.launched`, `agent.stopped`, `swarm.failed`) несут `traceId` из порта. В лог ушли `info swarm launch` и `error agent start timeout` с `missing`.
- **AC-016-6** — *Given* `agent-core` с фейковым `TraceContext`, *When* старт и сообщение, *Then* `agent.started`, `agent.working` и `agent.result` несут `traceId` из порта. Записаны `info agent started` и `debug message handled` с `messageId`.
- **AC-016-7** — *Given* ядра с фейковым логгером, *When* сценарии таблицы 4.8 (рой создан, оркестратор недоступен, отброшенное событие, ошибка `create`, таймауты, завершение, ошибка `remove`), *Then* по каждой строке таблицы есть запись с указанными уровнем, `msg` и ключами контекста. Ошибки переданы в `err`.
- **AC-016-8** — *Given* NATS и `adapter-telemetry` с экспортом спанов в память, *When*:
  - адаптер публикует сообщение внутри спана с `traceId: T`;
  - подписчик на `swarm.*.events` получает его;
  - сообщение без заголовка `traceparent`, опубликованное напрямую клиентом NATS,

  *Then*:
  - обработчик выполняется с `currentTraceId() = T`;
  - есть спаны `producer` и `consumer` с `messaging.destination.name` и `swarm.id`;
  - у сообщения без заголовка обработчик выполняется в новом трейсе без ошибки;
  - тело сообщения совпадает с опубликованным.
- **AC-016-9** — *Given* `api` и `orchestrator` на случайных портах, фейковый провайдер песочниц, экспорт спанов в память, *When* `POST /swarms` с заголовком `traceparent` (trace-id `T`), *Then*:
  - серверный спан `api`, клиентский спан вызова оркестратора и серверный спан `orchestrator` в трейсе `T`;
  - `swarm.created` и `agent.launched` несут `T`;
  - запрос с невалидным `traceparent` даёт `201` и событие с новым `traceId`.
- **AC-016-10** — *Given* Docker (как AC-001-22), *When* `adapter-docker.create` внутри спана с `traceId: T`, *Then* в env контейнера `TRACEPARENT` с trace-id `T` и `OTEL_EXPORTER_OTLP_ENDPOINT` из конфигурации адаптера, а в `SandboxSpec.env` от ядра их нет. Есть спан `sandbox.create` с `swarm.id` и `agent.id`. В CI обязателен, локально без Docker пропускается с сообщением.
- **AC-016-11** — *Given* оболочка агента с `TRACEPARENT` (trace-id `T`) и недоступным `NATS_URL`, экспорт логов в память, *When* старт, *Then* процесс выходит с кодом 1. Последняя запись лога — `error` с `traceId: T`, `swarmId`, `agentId` и `err` с причиной подключения. Сброс телеметрии вызван до выхода. Механизм теста (дочерний процесс или вызов функции старта с внедрёнными зависимостями) — выбор агента с записью в журнал.
- **AC-016-12** — *Given* сквозной тест AC-001-20, но с настоящим `TraceContext` из `adapter-telemetry` (без экспорта) и шиной в памяти, сохраняющей асинхронный контекст, *When* `createSwarm` внутри спана с `traceId: T`, рой завершается, затем второй рой останавливается через `stopSwarm` в спане `S`, *Then*:
  - у всех событий первого роя `traceId = T`, у `null` — ни одного;
  - у событий остановки второго роя (`agent.stopped`, `swarm.stopped`) — `S`.
- **AC-016-13** — *Given* сквозной тест AC-016-12 с перехватом всех логов, *When* рой с задачей и ролями, содержащими маркер `SECRET-MARKER-016`, *Then* ни одна строка лога и ни один атрибут спана не содержит маркер (по Q-4).
- **AC-016-14** — *Given* `ui-core` с шаблоном `http://g/x?t={traceId}`, *When* `traceUrl('abc…')` и `traceUrl(null)`, *Then* `http://g/x?t=abc…` и `null`.
- **AC-016-15** — *Given* `arch:check` и фикстура ядра с `import { trace } from '@opentelemetry/api'` или `import pino from 'pino'`, *When* проверка, *Then* выход 1 с файлом и спецификатором.
- **AC-016-16** `[manual]` — *Given* Docker и `.env` из `.env.example`, *When* `npm run up`, затем `npm run infra:check`, *Then* `otel-collector` и `lgtm` подняты, `infra:check` проверяет `grafana` и `otel-collector` и выходит с кодом 0. `docker compose ps` показывает: опубликован только `127.0.0.1:${GRAFANA_PORT}` из новых портов. Проверка: вывод в журнал.
- **AC-016-17** `[manual]` — *Given* поднятая система, *When* в UI запустить рой из трёх агентов и дождаться результата, *Then*:
  - у событий в ленте есть ссылка «Трейс», она открывает в Grafana трейс роя;
  - в трейсе есть HTTP `api`, вызов оркестратора, три `sandbox.create`, три `agent.start`, спаны NATS сообщений и событий, `sandbox.remove`;
  - из спана открываются логи трейса, из записи лога в Loki — трейс.

  Проверка: скриншоты трейса и перехода «лог → трейс» в журнал.
- **AC-016-18** `[manual]` — *Given* поднятая система с `DOCKER_AGENT_NATS_URL=nats://nonexistent:4222`, *When* запустить рой из двух агентов, *Then*:
  - рой `failed` с `agent_start_timeout`;
  - по ссылке «Трейс» у `swarm.failed` виден трейс со спанами `agent.start` с ошибкой;
  - в Loki у этого трейса есть `error`-логи агентов с причиной (не удалось подключиться к NATS) и `error agent start timeout` оркестратора с `missing`.

  Проверка: скриншоты и запрос LogQL в журнал. Это главный сценарий этапа 1а роадмапа.
- **AC-016-19** `[manual]` — *Given* поднятая система, *When* `docker compose stop otel-collector` и запуск роя из UI, *Then* рой завершается `completed`, логи сервисов идут в stdout, ошибки экспорта — не чаще одной записи `warn` в 10 с на сервис. Проверка: вывод в журнал.

## 6. Нефункциональные требования

| ID | Требование | Как измеряется |
|---|---|---|
| NFR-016-1 | Точка отсчёта: повтор замера NFR-001-1 (от `POST /swarms` до `swarm.started`, 3 агента) с включённой телеметрией и экспортом. Порог — по Q-3. | 10 прогонов, медиана и p95 рядом с цифрами 001, таблица в журнале |
| NFR-016-2 | `npm test` по-прежнему быстрее 60 с локально (без тестов, которым нужен Docker). | время команды |
| NFR-016-3 | Сброс телеметрии при остановке не дольше `TELEMETRY_FLUSH_TIMEOUT_MS` даже при недоступном Collector. | AC-016-19 и время `docker compose stop api` в журнале |

## 7. Безопасность: что не должно сломаться

- Ядра не знают OpenTelemetry и pino → AC-016-15, `arch:check`.
- В песочницу попадают только `TRACEPARENT` и адрес Collector, без адресов Grafana, Tempo и Loki, без учётных данных → AC-016-10, ревью `adapter-docker`.
- Пользовательский текст и секреты не утекают в логи и трейсы → AC-016-13, REQ-016-10, ревью таблицы 4.8.
- Grafana открыта только на `127.0.0.1`, Collector, Tempo и Loki не опубликованы. Входа в Grafana нет, поэтому наружу она не открывается до 012/014 → AC-016-16, ревью `compose.yaml`.
- Сбой телеметрии не роняет рой и сервисы → AC-016-19, REQ-016-7.
- Невалидный `traceparent` извне не ломает запрос → AC-016-3, AC-016-9.
- `traceId` в событиях не даёт доступа к трейсу: в 016 Grafana локальная. Доступ к трейсам по ролям — 012/014, связано с Q-5.
- Известное ограничение 016: агент шлёт телеметрию в Collector по общей сети compose. Закрытая сеть песочницы — 005 (Q-5).

## 8. Задачи для агента

Выполняются по порядку. После каждой задачи — коммит.

- [x] **T-1.** Контракты: `TraceId` и `traceId` в конверте (4.1), `LogRecord`, `LogLevel`, `ServiceName`, `LogError` (4.2). Все места, где ядра и тесты строят события, получают `traceId` (временно `null` до T-3). Тесты, README `contracts`. Закрывает: REQ-016-1 (схема), AC-016-1.
- [x] **T-2.** `packages/adapter-telemetry` (4.4): SDK, логгер в stdout и OTLP, `TraceContext`, `inSpan`, `currentTraceparent`, `shutdown`; тесты с экспортом в память; README. Закрывает: REQ-016-3, REQ-016-5 (логгер), REQ-016-6…8, AC-016-2, AC-016-3.
- [x] **T-3.** Порты `Logger` (4 уровня) и `TraceContext` в трёх ядрах. Конверты событий берут `traceId` из `TraceContext`, логи по таблице 4.8. Тесты, README ядер. `arch:check` с фикстурой OpenTelemetry и pino. Закрывает: REQ-016-1, REQ-016-4, REQ-016-9, AC-016-4…7, AC-016-15.
- [x] **T-4.** `adapter-nats`: перенос контекста и спаны 4.6; тест с настоящим NATS. Закрывает: REQ-016-2 (шина), REQ-016-15, AC-016-8.
- [ ] **T-5.** `adapter-docker`: `TRACEPARENT`, `OTEL_EXPORTER_OTLP_ENDPOINT`, спаны `sandbox.*` (4.7); `DOCKER_AGENT_OTLP_ENDPOINT` в конфигурации. Тест с Docker. Закрывает: REQ-016-14, AC-016-10.
- [ ] **T-6.** `@swag/config` (4.11). Оболочки `api` и `orchestrator` на `adapter-telemetry`: Fastify с общим логгером, приём `traceparent`, передача в `adapter-orchestrator-http`, `shutdown` по сигналу. Тест HTTP-цепочки. Закрывает: REQ-016-2 (HTTP), REQ-016-5, AC-016-9.
- [ ] **T-7.** Оболочка агента: телеметрия до NATS, спан `agent.start` от `TRACEPARENT`, ошибка старта → лог, сброс, код 1. Тест. Закрывает: REQ-016-8, AC-016-11.
- [ ] **T-8.** Сквозной тест с настоящим `TraceContext` и проверкой утечки пользовательского текста. Закрывает: REQ-016-2, REQ-016-10, AC-016-12, AC-016-13.
- [ ] **T-9.** `compose.yaml` и `compose.dev.yaml`: `otel-collector`, `lgtm`, `infra/otel-collector.yaml`, переменные 4.11 в `.env.example`, `infra:check` для `grafana` и `otel-collector`. Закрывает: REQ-016-11, REQ-016-12.
- [ ] **T-10.** `ui-core.traceUrl` и ссылка «Трейс» в ленте `apps/ui/cabinet`, источник шаблона — по Q-6. Закрывает: REQ-016-13, AC-016-14.
- [ ] **T-11.** Ручные проверки и замеры: AC-016-16…19, NFR-016-1…3. Затем README затронутых пакетов, корневой README (Grafana: адрес, как найти рой по `traceId`), сверка раздела наблюдаемости в `architecture.md`.

## 9. Открытые вопросы

- [x] **Q-1.** Как `traceId` попадает в конверт события, если ядро не знает OpenTelemetry? События строят ядра: `swarm.created` и `bus.message` — `api-core`, события роя — `orchestrator-core`, события агента — `agent-core`. Подписчики WebSocket получают событие прямо из `api-core`, не из адаптера. *(Claude, 2026-10-22)*
  - **(а)** Порт `TraceContext.currentTraceId()` в ядре (4.3). Ядро кладёт значение в конверт, не разбирая, адаптер берёт его из контекста OpenTelemetry. Правило `architecture.md` «ядро не читает `traceId`» уточняется: «получает через порт и переносит как непрозрачную строку». В тестах — фейк с константой.
  - **(б)** Ядро строит событие без `traceId`, его проставляет адаптер публикации (`publishEvent` в NATS). Для `api-core` это не работает: `swarm.created`, `swarm.failed` и `bus.message` не публикуются в шину, а сразу пишутся в хранилище и раздаются подписчикам. Пришлось бы проставлять `traceId` в `SwarmStore` и выносить раздачу подписчикам из ядра.
  - **(в)** Каждая операция ядра принимает `traceId` аргументом (`createSwarm(body, meta)`, `ingestMessage(raw, meta)`). Без нового порта, но сигнатуры всех операций меняются, а у событий по таймерам оркестратора явного входа нет.
  - **Рекомендация:** (а). Один порт, одинаковый во всех ядрах; ядро по-прежнему не зависит от OpenTelemetry, и это проверяет `arch:check`.

  **Ответ:** (а), порт `TraceContext` обязательный, как `Clock`: забытая зависимость ловится типами. `traceId` рождается в оболочке на триггере (запрос пользователя, позже внешний триггер), события платформы — его следствия и несут `traceId` триггера; ядро только переносит значение из порта в конверт события, не создаёт и не интерпретирует его. *(человек, 2026-10-22)*
- [x] **Q-2.** Библиотека логов в оболочках. *(из D-12; Claude, 2026-10-22)*
  - **(а)** pino: родной логгер Fastify (один логгер на сервис, `loggerInstance`), быстрый. Мост в OTLP — `@opentelemetry/instrumentation-pino` (отправка логов в Logs SDK) или transport `pino-opentelemetry-transport`, выбор при реализации.
  - **(б)** Свой тонкий логгер поверх OTel Logs SDK + `JSON.stringify` в stdout. Меньше зависимостей, но у Fastify остаётся второй логгер или нужен адаптер.
  - **(в)** winston. Нет преимуществ перед pino для Fastify.
  - **Рекомендация:** (а).

  **Ответ:** (а) — pino. *(человек, 2026-10-22)*
- [x] **Q-3.** Семплирование, хранение, отдельный Collector и порог накладных расходов. *(из D-12; Claude, 2026-10-22)*
  - **Семплирование.** Локально — 100% (`parentbased_always_on`). Для сервера («по доле и всегда при ошибке» — это tail sampling в Collector) — решать при деплое, вне 016. Рекомендация: так.
  - **Хранение.** В compose — значения по умолчанию `otel-lgtm` плюс volume `lgtm-data`. Сроки для сервера — вне 016. Рекомендация: так.
  - **Collector.** `grafana/otel-lgtm` содержит свой Collector. Варианты:
    - **(а)** отдельный `otel/opentelemetry-collector-contrib` перед `lgtm`, конфигурация в репозитории. Как в роадмапе: смена бэкенда — правка конфигурации Collector, а песочницы знают только Collector;
    - **(б)** только встроенный Collector `lgtm`, на один контейнер меньше, но адрес песочниц указывает прямо в бэкенд.

    Рекомендация: (а).
  - **Порог NFR-016-1.** Без порога (точка отсчёта, как в 001) или «медиана хуже 001 не более чем на 10%»? Рекомендация: без порога, порог — когда появится тёплый пул (005).

  **Ответ:** семплирование 100% локально, хранение по умолчанию `otel-lgtm` с volume, отдельный Collector (а), NFR-016-1 без порога. *(человек, 2026-10-22)*
- [x] **Q-4.** Что из пользовательского текста можно писать в логи и атрибуты спанов? *(из D-12; Claude, 2026-10-22)*
  - **(а)** Только id, числа и длины (`taskLength`, `textLength`). Текст задачи, ролей, сообщений и результата остаётся только в событиях платформы, где с 012 будет проверка доступа. Grafana с 012 видит супервизор, а не владелец роя.
  - **(б)** Текст целиком на уровне `debug`, выключенном по умолчанию. Удобно в разработке, но одна смена `LOG_LEVEL` — и текст пользователей в Loki.
  - **Рекомендация:** (а). AC-016-13 проверяет это маркером.

  **Ответ:** (а) — только id, числа и длины. *(человек, 2026-10-22)*
- [x] **Q-5.** Песочница с закрытой сетью и доступ к Grafana. *(из D-12; Claude, 2026-10-22)*
  - **Закрытая сеть.** Как песочница с закрытой сетью (005) достаёт до Collector? Варианты для 005: Collector подключается к сети каждого роя; отдельный Collector-шлюз на рой; телеметрия через шину. Рекомендация: решать в 005, а в 016 — общая сеть compose, как у NATS в 001. Перенести в `questions.md` с адресом 005.
  - **Доступ к Grafana.** Видит ли супервизор Grafana напрямую или через ссылку из своего фронтенда? Рекомендация: решать в 014 вместе с фронтендом супервизора. Перенести в `questions.md` с адресом 014.

  **Ответ:** по рекомендации — в 016 общая сеть compose; оба вопроса перенесены в `questions.md`: D-14 (005), D-15 (014). *(человек, 2026-10-22)*
- [x] **Q-6.** Откуда UI берёт адрес Grafana для ссылки «Трейс»? *(Claude, 2026-10-22)*
  - **(а)** Прокси `ng serve`: `/grafana` → `lgtm:3000`, Grafana настроена на подпуть (`GF_SERVER_ROOT_URL`, `GF_SERVER_SERVE_FROM_SUB_PATH`). Ссылка относительная, в UI без конфигурации, как `/api` в 001. Grafana тогда доступна и через порт UI.
  - **(б)** Абсолютный адрес `http://127.0.0.1:${GRAFANA_PORT}` в окружении Angular на этапе сборки. Работает только локально, при смене порта надо пересобирать.
  - **(в)** `api` отдаёт шаблон ссылки (`GET /config`). Новый эндпоинт ради одной ссылки.
  - **Рекомендация:** (а).

  **Ответ:** (а) — прокси `/grafana` в `ng serve`, Grafana на подпути, ссылка относительная. *(человек, 2026-10-22)*
- [x] **Q-7.** Начинается ли трейс в браузере? Роадмап пишет «UI → `api` → …». *(Claude, 2026-10-22)*
  - **(а)** Трейс начинается в `api`, UI получает `traceId` из событий. Ссылка «Трейс» работает, браузер телеметрию не шлёт.
  - **(б)** Angular-интерцептор создаёт `traceparent` на действие пользователя (создать, остановить). `traceId` известен UI до ответа, но спанов браузера в Tempo нет, так что выигрыш почти нулевой.
  - **(в)** OpenTelemetry SDK в браузере, спаны UI отправляются в Collector через прокси. Нужен CORS или прокси, а в Tempo попадают данные с клиента без входа.
  - **Рекомендация:** (а), а (в) — после 014, когда будет вход. Это отличие от буквы роадмапа, поэтому нужно подтверждение.

  **Ответ:** (а) — трейс начинается в `api`, SDK в браузере нет; (в) — после 014. *(человек, 2026-10-22)*

## 10. Журнал реализации

Заполняет агент.

| Дата | Ветка / коммит | Что сделано | Отклонения от спеки |
|---|---|---|---|
