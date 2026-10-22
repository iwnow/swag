# @swag/adapter-telemetry

Телеметрия для оболочек: OpenTelemetry SDK, структурный логгер на pino, порт `TraceContext`, спаны и перенос контекста W3C `traceparent`, сброс телеметрии при остановке. Ядра пакет не импортируют — они видят только порты `Logger` и `TraceContext` ([спека 016, 4.3–4.4](../../docs/spec/016-observability.md#44-packagesadapter-telemetry)).

## Задачи

- Один `traceId` на рой через все сервисы: оболочка принимает `traceparent` (HTTP-заголовок, env `TRACEPARENT`) и выполняет операцию в спане (`inSpan`), адаптеры передают `currentTraceparent()` дальше.
- Логи одной схемы `LogRecord` (`@swag/contracts`) в stdout и, если задан `otlpEndpoint`, в OTLP Logs.
- Трейсы в OTLP, если задан `otlpEndpoint`.
- Сброс при остановке не дольше `flushTimeoutMs` даже при недоступном Collector (REQ-016-8).

## Что внутри сейчас

- `startTelemetry(options): Telemetry` — `logger` (`debug`/`info`/`warn`/`error` + `pino` для Fastify `loggerInstance`), `trace.currentTraceId()`, `inSpan(name, { parent, kind, attributes }, fn)`, `currentTraceparent()`, `shutdown()`.
- `tracedHttpServer(telemetry, { ignorePaths })` — `serverFactory` для Fastify: серверный спан на запрос, родитель — заголовок `traceparent`, атрибуты `http.request.method`, `url.path`, `http.response.status_code`.
- `toLogError(value)` — ошибка → `LogError` (класс, сообщение, стек, сообщение причины).
- `createMemoryExporters()` — экспорт спанов и логов в память для тестов других пакетов.
- Типы `Logger`, `LogContext`, `TraceContext` — структурные копии портов ядер.

## Ключевые решения

- **Версии** (последние стабильные на 2026-10-22): `@opentelemetry/api` 1.10.0; `core`, `resources`, `sdk-trace`, `sdk-logs`, `context-async-hooks` 3.0.0; `exporter-trace-otlp-http`, `exporter-logs-otlp-http` 0.300.0; `pino` 10.4.0 (та же, что у Fastify 5.12.7). В линии 3.x SDK трейсов — один пакет `@opentelemetry/sdk-trace` (вместо `sdk-trace-base` и `sdk-trace-node`), API логов входит в `@opentelemetry/api`.
- **Без `@opentelemetry/sdk-node` и автоинструментации.** Провайдеры, пропагатор и контекст собираются вручную: так видно, что именно включено, и нет патчинга модулей через загрузчик ESM. HTTP-сервер трассируется `tracedHttpServer`, HTTP-клиент, NATS и Docker — явным кодом в своих адаптерах (только `@opentelemetry/api`).
- **Контекст — `AsyncLocalStorageContextManager`**: `currentTraceId()` верен в колбэках таймеров и промисов, запущенных внутри спана (AC-016-3).
- **Пропагатор — W3C Trace Context**; невалидный `traceparent` пропагатор игнорирует, и `inSpan` начинает новый трейс (REQ-016-3). `parent: null` — явный новый трейс, `parent` не задан — активный контекст.
- **Семплер** — `ParentBased(AlwaysOn)` (`parentbased_always_on`, Q-3).
- **Провайдер трейсов есть всегда**, даже без `otlpEndpoint`: иначе в логах и событиях не было бы `traceId` (AC-016-2, REQ-016-6).
- **Мост pino → OTLP Logs — свой поток назначения pino** (Q-2 оставлял выбор между `@opentelemetry/instrumentation-pino` и `pino-opentelemetry-transport`, см. D-17): pino пишет строку в поток; поток отдаёт её в stdout и ту же запись — в `Logger.emit` OTLP с `traceId`/`spanId` из записи. Без патчинга модуля (instrumentation-pino в ESM требует хуков загрузчика) и без worker-потока транспорта, поэтому `shutdown` полностью управляет сбросом.
- **Формат записи** по 4.2: `base: { service }` (без `pid`, `hostname`), `time` — ISO, `level` — строкой; уровни Fastify `trace` и `fatal` сводятся к `debug` и `error`. `traceId` и `spanId` добавляет `mixin` из активного контекста. Сериализаторы `req` (метод и путь без query) и `res` (код ответа) — без заголовков и тела (REQ-016-10).
- **Пакетный экспорт раз в 1 с** (`scheduledDelayMillis`, у SDK по умолчанию 5 с для спанов): короткоживущий агент успевает отправить спаны до остановки; остальное досылает `shutdown`.
- **Ошибки экспорта** перехватываются глобальным обработчиком OpenTelemetry и пишутся `warn telemetry export failed` только в stdout, не чаще раза в 10 с (REQ-016-7, AC-016-19).
- **Один экземпляр на процесс**: `startTelemetry` переустанавливает глобальные провайдер, пропагатор и менеджер контекста, `shutdown` их снимает. Адаптеры берут трейсер из глобального API при каждом вызове.
- **`exporters` в `TelemetryOptions`** — расширение 4.4 для тестов: экспорт в память без пакетирования. В работе не используется.
- **`/health` не трассируется** (`ignorePaths`): compose опрашивает его каждые 2 с.

## Ограничения

- Метрик нет (этап 16 роадмапа). Спаны LLM — спека 002.
- `shutdown` снимает глобальный контекст: вызывать его последним, перед выходом процесса.
- Без экспорта (`otlpEndpoint: null`) логи пишутся только в stdout.
- `shutdown` ограничен `flushTimeoutMs`, но выход процесса — нет: если имя Collector не резолвится (контейнер остановлен), незавершённый DNS-запрос экспортёра задерживает выход агента до 3,8–4 с при лимите 2 с (замер AC-016-19, D-20).

## Связи

- Используют: оболочки `apps/api`, `apps/orchestrator`, `apps/agent`; тесты `adapter-nats`, `adapter-docker` и оболочек (`createMemoryExporters`).
- Зависит от: `@swag/contracts` (`LogLevel`, `ServiceName`, `LogError`), `@opentelemetry/*`, `pino`.

## Спеки

- 016 — разделы 4.3, 4.4, 4.5 (сервер), REQ-016-3, REQ-016-5…8, AC-016-2, AC-016-3.
