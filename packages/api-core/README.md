# @swag/api-core

Ядро API платформы: рои — создание, список, состояние, события, остановка, приём событий и сообщений шины. Чистый TypeScript, не знает про HTTP, Fastify, NATS, Postgres и Docker.

## Задачи

- Создать рой: проверить запрос (`SwarmCreateRequest`), лимит активных роёв, записать `swarm.created`, вызвать оркестратор; при отказе оркестратора — `swarm.failed` (`orchestrator_unavailable`).
- Принять события роя (`swarm.*.events`) и сообщения агентов (`swarm.*.agent.*.inbox`): валидировать, назначить сквозной `seq`, превратить сообщение в `bus.message`. Событие `llm.call` от `llm-gateway` (спека 002) принимается и хранится так же, как остальные события из шины.
- Отдать события с `seq > after` и подписать на новые (поток WebSocket) без пропусков и повторов.
- Остановить рой; рой в финальном статусе — `swarm_finished`.

Пользователи, вход и роли — будущие ядра `identity-core` (спека 012), пока роя принадлежат единственному локальному пользователю.

## Что внутри сейчас

- `createApiCore(deps)` с портами `SwarmStore` (асинхронный), `OrchestratorClient`, `Clock`, `IdGenerator`, `Logger` (`debug`/`info`/`warn`/`error` с `LogContext`), `TraceContext`.
- Операции (все асинхронные): `createSwarm`, `listSwarms`, `getSwarm`, `getEvents`, `stopSwarm`, `ingestEvent`, `ingestMessage`, `subscribe`; синхронная `info`.
- Логи по таблице 4.8 спеки 016: `info swarm created`, `error orchestrator unavailable`, `warn event dropped` / `message dropped` с `reason` (`invalid_schema`, `created_from_bus`, `unknown_swarm`, `not_applicable`).
- Тесты: `test/api-core.test.ts` — AC-000-16, AC-001-3…8, AC-001-10, AC-002-26, AC-003-4, AC-003-5, AC-016-4, AC-016-7.
- Закрытие прерванных роёв (`closeInterrupted`, спека 003, T-4) пока не реализовано.

## Ограничения

Правила ядра ([архитектура](../../docs/architecture.md), [спека 000, 4.2](../../docs/spec/000-foundation.md#42-правила-ядра-и-оболочки)):

- Зависимости — `@swag/contracts`, `@swag/api-integration`.
- Нет Node API, `process`, env, файлов, сети: `tsconfig` без `@types/node` и DOM.
- Всё внешнее — через порты; реализации передаёт оболочка.

Нарушения ловят `npm run arch:check` и `npm run typecheck`.

Очередь записи живёт в памяти одного процесса: несколько экземпляров `api` её не объединяют (спека 003, «Не входит»).

## Связи

- Оболочка: `apps/api`.
- Адаптеры: `@swag/adapter-memory` (хранилище для тестов ядра), `@swag/adapter-orchestrator-http` (оркестратор). Хранилище на Postgres — `@swag/adapter-postgres` (спека 003, T-6).
- Использует: `@swag/contracts`, `@swag/api-integration` (проекция роя, `FINAL_SWARM_STATUSES`).

## Ключевые решения

- Порт `SwarmStore` асинхронный (003, Q-1): `appendEvent` — reject на недопустимое событие; `events` — по возрастанию `seq`.
- Номер события `seq` назначает ядро при записи (`lastSeq + 1`), издатели его не знают (4.3, 4.5.4).
- Очередь записи (003, REQ-003-3): все записи одного роя — цепочка `Promise` (`commit`), внутри звена: прочитать `lastSeq`, записать событие, разослать подписчикам. Ошибка записи — `warn` (`event dropped` / `message dropped`, `reason: not_applicable`), цепочка не рвётся. Записи разных роёв идут параллельно.
- Подписка с буфером (003, REQ-003-4): `subscribe` сначала проверяет рой, затем регистрирует подписчика, затем читает историю `seq > after`. События, записанные во время чтения, копятся в буфере подписчика; после истории отдаются буфер и новые события. Подписчик отслеживает последний отданный `seq`, поэтому каждое событие уходит ровно один раз и по возрастанию. Отписка работает и во время чтения истории.
- `createSwarm`: `swarm.created` пишется до вызова оркестратора; ошибка оркестратора → `swarm.failed` (`orchestrator_unavailable`), ответ остаётся 201 (4.5.1, AC-001-6).
- Лимит активных роёв (`MAX_ACTIVE_SWARMS`) проверяется по `store.views()` до записи; при параллельных `createSwarm` проверка и запись не атомарны (см. «Ограничения»).
- `traceId` (016, Q-1): ядро берёт его из обязательного порта `TraceContext` для событий, которые строит само (`swarm.created`, `swarm.failed`, `bus.message`), и переносит в конверт как непрозрачную строку. Событие из шины хранится с тем `traceId`, с которым его опубликовали. OpenTelemetry ядро не знает.
- Итоговый статус роя окончательный (003, REQ-003-7): `stopSwarm` и проверка финальности используют `FINAL_SWARM_STATUSES` из `api-integration`.
- В логах только id, числа и перечисления: текст задачи, ролей и сообщений в контекст не попадает (016, Q-4). Ошибка — в поле `err`.
- Отклонение: `stopSwarm` при ошибке оркестратора (например, 404) отдаёт исключение, а не код ошибки API — в 4.5.3 такого кода нет. Вопрос к приёмке.

## Спеки

- 000 — заглушка.
- 001 — 4.5 ([REST и WebSocket](../../docs/spec/001-walking-skeleton.md#45-api)).
- 002 — `llm.call` от `llm-gateway`: приём, `seq`, `unknown_swarm` (REQ-002-15, AC-002-26).
- 003 — асинхронный порт, очередь записи, подписка с буфером (REQ-003-3, REQ-003-4, AC-003-4, AC-003-5); закрытие прерванных роёв — T-4.
- 016 — порты `Logger` и `TraceContext`, логи 4.8.
