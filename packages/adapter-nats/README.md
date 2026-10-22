# @swag/adapter-nats

Адаптер шины: публикация и подписка JSON поверх Core NATS (без JetStream) с переносом контекста трассировки в заголовке сообщения. Общий для `api`, `orchestrator` и `agent`: порты шины каждого ядра оболочка собирает поверх этого адаптера.

## Задачи

- `connectNatsBus({ url, warn })` — соединение.
- `publishJson(subject, value)` — публикация JSON в UTF-8 в спане `producer`, `traceparent` текущего контекста — в заголовке сообщения.
- `subscribeJson(subject, handler)` — подписка. Обработчик вызывается в спане `consumer`, родитель — `traceparent` из заголовков, без заголовка — новый трейс. Невалидный JSON пропускается с предупреждением; исключение в обработчике не останавливает подписку.
- `close()` — drain соединения.

## Что внутри сейчас

- `src/index.ts` — `connectNatsBus`, интерфейс `NatsBus`, `subjectAttributes` (атрибуты спана по subject).
- `test/nats.test.ts` — AC-001-21 и AC-016-8, выполняются только при `NATS_TEST_URL` (в CI — сервис NATS); разбор subjects — без NATS.

## Ограничения

- Subjects и тела не проверяются здесь: это делают ядра и оболочки через схемы `@swag/contracts`.
- Изоляции роёв нет: все рои на одном account (спека 007).
- Спан `consumer` закрывается, когда синхронный обработчик вернул управление; асинхронная работа обработчика продолжается в его контексте, но вне длительности спана.

## Связи

- Использует: `@nats-io/transport-node`, `@opentelemetry/api`.
- Тесты: `@swag/adapter-telemetry` (devDependency) — SDK и экспорт спанов в память.
- Оболочки: `apps/api`, `apps/orchestrator`, `apps/agent`.

## Ключевые решения

- Библиотека `@nats-io/transport-node` версии 3.4.0 (как в корневых devDependencies, зафиксирована точно: `save-exact`).
- Один адаптер на все оболочки: JSON в UTF-8 через `TextEncoder`/`TextDecoder`. Схемы не проверяет — это делают ядра (`BusMessage`, `PlatformEventInput`).
- Ошибки JSON и исключения обработчика не останавливают подписку (AC-001-21).
- Трассировка (016, 4.6) — только через `@opentelemetry/api` 1.10.0: без зарегистрированного SDK это no-op, тесты без телеметрии работают как раньше. Трейсер и пропагатор берутся из глобального API при каждом вызове, чтобы пережить перезапуск телеметрии.
- Тело сообщения не меняется, контекст — только в заголовке `traceparent` (W3C, глобальный пропагатор).
- Имена спанов — `publish <шаблон>` и `process <шаблон>` с шаблоном subject без id (`swarm.{swarmId}.events`, `swarm.{swarmId}.agent.{agentId}.inbox`), чтобы имена не размножались по роям. Атрибуты по семантическим соглашениям messaging: `messaging.system=nats`, `messaging.destination.name=<subject>`, `messaging.operation.type`; `swarm.id` и `agent.id` — разбором subject (REQ-016-15).
- Отклонение от 4.10 спеки 001: зависимости `@swag/contracts` у адаптера нет — он не знает типов, subjects строят оболочки через `eventsSubject`/`inboxSubject`; разбор subject для атрибутов — по токенам в `subjectAttributes`.

## Спеки

- 001 — 4.2, AC-001-21.
- 016 — 4.6, REQ-016-15, AC-016-8.
