# @swag/contracts

Общие схемы Zod и типы, которыми обмениваются сервисы и ядра: запрос на рой, рой, агент, запуск роя, сообщение шины, события платформы, subjects NATS, `ServiceInfo`.

## Задачи

- Единые контракты из [спеки 001, раздел 4](../../docs/spec/001-walking-skeleton.md#4-контракты): `swarm.ts` (4.1), `bus.ts` (4.2), `events.ts` (4.3).
- Типы выводятся из схем (`z.infer`), отдельно их не пишут.

## Что внутри сейчас

- `swarm.ts` — `AgentId`, `SwarmId`, `SwarmCreateRequest`, `AgentSpec`, `SwarmStatus`, `AgentStatus`, `SwarmLaunch`, `SwarmSummary`.
- `bus.ts` — `BusMessage`, subjects `inboxSubject`, `eventsSubject`, `ALL_INBOXES`, `ALL_EVENTS`.
- `events.ts` — `PlatformEventInput` (дискриминированное объединение по `type`), `PlatformEvent` (с `seq`).
- `service-info.ts` — `ServiceInfo`.

## Ограничения

- Схемы и типы, а также чистые правила над ними. Логики предметной области здесь нет, кроме проверок формы.
- Зависимости — только `zod`. Правила ядра проверяет `arch:check` (REQ-001-15, N-3).
- Лимиты длин полей (`max(4000)`, `max(500)`, `max(40)`, `max(8)`) — предложение, утверждено в Q-3.

## Связи

- Используют: все ядра (`api-core`, `orchestrator-core`, `agent-core`), `api-integration`, `ui-core`, адаптеры и оболочки.

## Ключевые решения

- Схемы zod 4 (`z.uuid()`, `z.iso.datetime()`, `z.strictObject`) — лишнее поле в запросе отклоняется (AC-001-1, AC-001-12).
- `PlatformEvent` = `PlatformEventInput & { seq }`: `seq` не входит в публикуемый контракт (4.3).
- Отклонение от 4.1: `SwarmSummary` добавлен в `swarm.ts` (нужен и `api`, и `ui`), не в отдельный файл.

## Спеки

- 000 — `ServiceInfo`.
- 001 — разделы 4.1–4.3.
