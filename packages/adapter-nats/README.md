# @swag/adapter-nats

Адаптер шины: публикация и подписка JSON поверх Core NATS (без JetStream) с переносом контекста трассировки в заголовке сообщения. Общий для `api`, `orchestrator`, `agent` и `llm-gateway`: порты шины каждого ядра оболочка собирает поверх этого адаптера.

## Задачи

- `connectNatsBus({ url, warn })` — соединение.
- `publishJson(subject, value)` — публикация JSON в UTF-8 в спане `producer`, `traceparent` текущего контекста — в заголовке сообщения.
- `subscribeJson(subject, handler)` — подписка. Обработчик вызывается в спане `consumer`, родитель — `traceparent` из заголовков, без заголовка — новый трейс. Обработчик может вернуть `Promise`: адаптер ждёт его до конца спана, сообщения одной подписки обрабатываются по одному в порядке поступления. Невалидный JSON пропускается с предупреждением; исключение или отказ обработчика не останавливает подписку и даёт спану статус `ERROR`.
- `close()` — drain соединения.

## Что внутри сейчас

- `src/index.ts` — `connectNatsBus`, интерфейс `NatsBus`, `subjectAttributes` (атрибуты спана по subject).
- `test/nats.test.ts` — AC-001-21 и AC-016-8, выполняются только при `NATS_TEST_URL` (в CI — сервис NATS); разбор subjects — без NATS.

## Ограничения

- Subjects и тела не проверяются здесь: это делают ядра и оболочки через схемы `@swag/contracts`.
- Изоляции роёв нет: все рои на одном account (спека 007).
- Пока обработчик не завершил `Promise`, следующие сообщения этой подписки ждут в очереди: медленный обработчик задерживает подписку целиком. Оркестратор передаёт `void`-вызов `core.handleEvent` без `return`, поэтому его спан `consumer` покрывает только постановку вызова (как и раньше).

## Связи

- Использует: `@nats-io/transport-node`, `@opentelemetry/api`.
- Тесты: `@swag/adapter-telemetry` (devDependency) — SDK и экспорт спанов в память.
- Оболочки: `apps/api`, `apps/orchestrator`, `apps/agent`, `apps/llm-gateway`.

## Ключевые решения

- Библиотека `@nats-io/transport-node` версии 3.4.0 (как в корневых devDependencies, зафиксирована точно: `save-exact`).
- Один адаптер на все оболочки: JSON в UTF-8 через `TextEncoder`/`TextDecoder`. Схемы не проверяет — это делают ядра (`BusMessage`, `PlatformEventInput`).
- Ошибки JSON и исключения обработчика не останавливают подписку (AC-001-21).
- Асинхронный обработчик (REQ-022-14, Q-2 спеки 022): цикл `for await` ждёт результат обработчика, спан `consumer` закрывается после него, отказ — статус `ERROR`. Сообщения одной подписки идут по одному, по порядку поступления; ход агента (секунды и минуты) виден в спане с его длительностью. Синхронный обработчик — частный случай (`await` на не-Promise ничего не меняет), поэтому `apps/api` и `apps/orchestrator` не менялись. Тип обработчика — `void | Promise<void>`.
- Трассировка (016, 4.6) — только через `@opentelemetry/api` 1.10.0: без зарегистрированного SDK это no-op, тесты без телеметрии работают как раньше. Трейсер и пропагатор берутся из глобального API при каждом вызове, чтобы пережить перезапуск телеметрии.
- Тело сообщения не меняется, контекст — только в заголовке `traceparent` (W3C, глобальный пропагатор).
- Имена спанов — `publish <шаблон>` и `process <шаблон>` с шаблоном subject без id (`swarm.{swarmId}.events`, `swarm.{swarmId}.agent.{agentId}.inbox`), чтобы имена не размножались по роям. Атрибуты по семантическим соглашениям messaging: `messaging.system=nats`, `messaging.destination.name=<subject>`, `messaging.operation.type`; `swarm.id` и `agent.id` — разбором subject (REQ-016-15).
- Сверка с документацией (T-33 спеки 002, 2026-10-28), `@nats-io/transport-node` 3.4.0: импорт `connect` и установка — по README пакета (https://github.com/nats-io/nats.js); `connect({ servers, name })`, `publish(subject, data, { headers })`, `headers()`, `Subscription` как `AsyncIterable<Msg>`, `drain()` — по типам `@nats-io/nats-core`, которые пакет реэкспортирует. Миграция v3 (https://raw.githubusercontent.com/nats-io/nats.js/main/migration.md) убрала `JSONCodec`/`StringCodec`, `NatsError`, `jetStream()` на соединении — адаптер их не использует. Node: README пакета — текущая и LTS-версия, как у репозитория (Node 24).
- Отклонение от 4.10 спеки 001: зависимости `@swag/contracts` у адаптера нет — он не знает типов, subjects строят оболочки через `eventsSubject`/`inboxSubject`; разбор subject для атрибутов — по токенам в `subjectAttributes`.

## Спеки

- 022 — REQ-022-14, AC-022-22 (асинхронный обработчик).
- 001 — 4.2, AC-001-21.
- 016 — 4.6, REQ-016-15, AC-016-8.
- 002 — оболочка `llm-gateway` публикует `llm.call` через этот адаптер.
