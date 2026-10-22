# @swag/adapter-nats

Адаптер шины: публикация и подписка JSON поверх Core NATS (без JetStream). Общий для `api`, `orchestrator` и `agent`: порты шины каждого ядра оболочка собирает поверх этого адаптера.

## Задачи

- `connectNatsBus({ url, warn })` — соединение.
- `publishJson(subject, value)` — публикация JSON в UTF-8.
- `subscribeJson(subject, handler)` — подписка. Невалидный JSON пропускается с предупреждением; исключение в обработчике не останавливает подписку.
- `close()` — drain соединения.

## Что внутри сейчас

- `src/index.ts` — `connectNatsBus`, интерфейс `NatsBus`.
- `test/nats.test.ts` — AC-001-21, выполняется только при `NATS_TEST_URL` (в CI — сервис NATS).

## Ограничения

- Subjects и тела не проверяются здесь: это делают ядра и оболочки через схемы `@swag/contracts`.
- Изоляции роёв нет: все рои на одном account (спека 007).

## Связи

- Использует: `@nats-io/transport-node`.
- Оболочки: `apps/api`, `apps/orchestrator`, `apps/agent`.

## Ключевые решения

- Библиотека `@nats-io/transport-node` версии 3.4.0 (как в корневых devDependencies, зафиксирована точно: `save-exact`).
- Один адаптер на все оболочки: JSON в UTF-8 через `TextEncoder`/`TextDecoder`. Схемы не проверяет — это делают ядра (`BusMessage`, `PlatformEventInput`).
- Ошибки JSON и исключения обработчика не останавливают подписку (AC-001-21).
- Отклонение от 4.10: зависимости `@swag/contracts` у адаптера нет — он не знает типов, subjects строят оболочки через `eventsSubject`/`inboxSubject`.

## Спеки

- 001 — 4.2, AC-001-21.
