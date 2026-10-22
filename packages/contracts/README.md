# @swag/contracts

Общие схемы Zod и типы, которыми обмениваются сервисы и ядра: запрос на рой, рой, агент, запуск роя, сообщение шины, события платформы, subjects NATS, `ServiceInfo`, `traceId` и схема структурного лога.

## Задачи

- Единые контракты из [спеки 001, раздел 4](../../docs/spec/001-walking-skeleton.md#4-контракты): `swarm.ts` (4.1), `bus.ts` (4.2), `events.ts` (4.3).
- Контракты наблюдаемости из [спеки 016](../../docs/spec/016-observability.md#4-контракты): `traceId` в конверте события (4.1), `LogRecord` (4.2).
- Типы выводятся из схем (`z.infer`), отдельно их не пишут.

## Что внутри сейчас

- `swarm.ts` — `AgentId`, `SwarmId`, `SwarmCreateRequest`, `AgentSpec`, `SwarmStatus`, `AgentStatus`, `SwarmLaunch`, `SwarmSummary`.
- `bus.ts` — `BusMessage`, subjects `inboxSubject`, `eventsSubject`, `ALL_INBOXES`, `ALL_EVENTS`.
- `events.ts` — `TraceId`, `PlatformEventInput` (дискриминированное объединение по `type`, в конверте `traceId: TraceId | null`), `PlatformEvent` (с `seq`).
- `log.ts` — `LogLevel`, `ServiceName`, `LogError`, `LogRecord`.
- `service-info.ts` — `ServiceInfo`.

## Ограничения

- Схемы и типы, а также чистые правила над ними. Логики предметной области здесь нет, кроме проверок формы.
- Зависимости — только `zod`. Правила ядра проверяет `arch:check` (REQ-001-15, N-3).
- Лимиты длин полей (`max(4000)`, `max(500)`, `max(40)`, `max(8)`) — предложение, утверждено в Q-3.

## Связи

- Используют: все ядра (`api-core`, `orchestrator-core`, `agent-core`), `api-integration`, `ui-core`, адаптеры (`adapter-telemetry` — `LogRecord`, `LogLevel`, `ServiceName`) и оболочки.

## Ключевые решения

- Схемы zod 4 (`z.uuid()`, `z.iso.datetime()`, `z.strictObject`) — лишнее поле в запросе отклоняется (AC-001-1, AC-001-12).
- `PlatformEvent` = `PlatformEventInput & { seq }`: `seq` не входит в публикуемый контракт (4.3).
- `traceId` в конверте обязателен, но допускает `null` (016, 4.1): событие без контекста не отбрасывается, а отсутствие поля — ошибка схемы.
- `LogRecord` — `z.looseObject`: Fastify добавляет `req`, `res`, `responseTime`; `err` — строгий `LogError`, поэтому лишние поля ошибки (например, `code`) адаптер логгера отбрасывает.
- Отклонение от 4.1: `SwarmSummary` добавлен в `swarm.ts` (нужен и `api`, и `ui`), не в отдельный файл.

## Спеки

- 000 — `ServiceInfo`.
- 001 — разделы 4.1–4.3.
- 016 — разделы 4.1, 4.2.
