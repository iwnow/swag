# @swag/api-core

Ядро API платформы: рои — создание, список, состояние, события, остановка, приём событий и сообщений шины. Чистый TypeScript, не знает про HTTP, Fastify, NATS и Docker.

## Задачи

- Создать рой: проверить запрос (`SwarmCreateRequest`), лимит активных роёв, записать `swarm.created`, вызвать оркестратор; при отказе оркестратора — `swarm.failed` (`orchestrator_unavailable`).
- Принять события роя (`swarm.*.events`) и сообщения агентов (`swarm.*.agent.*.inbox`): валидировать, назначить сквозной `seq`, превратить сообщение в `bus.message`. Событие `llm.call` от `llm-gateway` (спека 002) принимается и хранится так же, как остальные события из шины.
- Отдать события с `seq > after` и подписать на новые (поток WebSocket).
- Остановить рой; рой в финальном статусе — `swarm_finished`.

Пользователи, вход и роли — будущие ядра `identity-core` (спека 012), пока роя принадлежат единственному локальному пользователю.

## Что внутри сейчас

- `createApiCore(deps)` с портами `SwarmStore`, `OrchestratorClient`, `Clock`, `IdGenerator`, `Logger` (`debug`/`info`/`warn`/`error` с `LogContext`), `TraceContext`.
- Операции: `createSwarm`, `listSwarms`, `getSwarm`, `getEvents`, `stopSwarm`, `ingestEvent`, `ingestMessage`, `subscribe`, `info`.
- Логи по таблице 4.8 спеки 016: `info swarm created`, `error orchestrator unavailable`, `warn event dropped` / `message dropped` с `reason` (`invalid_schema`, `created_from_bus`, `unknown_swarm`, `not_applicable`).
- Тесты: `test/api-core.test.ts` — AC-001-3…8, AC-001-10, AC-002-26, AC-016-4, AC-016-7.

## Ограничения

Правила ядра ([архитектура](../../docs/architecture.md), [спека 000, 4.2](../../docs/spec/000-foundation.md#42-правила-ядра-и-оболочки)):

- Зависимости — `zod`, `@swag/contracts`, `@swag/api-integration`.
- Нет Node API, `process`, env, файлов, сети: `tsconfig` без `@types/node` и DOM.
- Всё внешнее — через порты; реализации передаёт оболочка.

Нарушения ловят `npm run arch:check` и `npm run typecheck`.

## Связи

- Оболочка: `apps/api`.
- Адаптеры: `@swag/adapter-memory` (хранилище), `@swag/adapter-orchestrator-http` (оркестратор).
- Использует: `@swag/contracts`, `@swag/api-integration` (проекция роя).

## Ключевые решения

- Номер события `seq` назначает ядро при записи (`lastSeq + 1`), издатели его не знают (4.3, 4.5.4). Сообщение шины превращается в `bus.message` с `id` сообщения в `data.messageId`.
- `createSwarm`: `swarm.created` пишется до вызова оркестратора; ошибка оркестратора → `swarm.failed` (`orchestrator_unavailable`), ответ остаётся 201 (4.5.1, AC-001-6).
- `subscribe` сначала синхронно отдаёт хвост `seq > after`, затем регистрирует слушателя — между ними событие не теряется, потому что JS однопоточен.
- Порты `Result` и ошибки — собственные типы ядра (без зависимостей), коды — из 4.5.3.
- `traceId` (016, Q-1): ядро берёт его из обязательного порта `TraceContext` для событий, которые строит само (`swarm.created`, `swarm.failed`, `bus.message`), и переносит в конверт как непрозрачную строку. Событие из шины хранится с тем `traceId`, с которым его опубликовали. OpenTelemetry ядро не знает.
- В логах только id, числа и перечисления: текст задачи, ролей и сообщений в контекст не попадает (016, Q-4). Ошибка — в поле `err`.
- Отклонение: `stopSwarm` при ошибке оркестратора (например, 404) отдаёт исключение, а не код ошибки API — в 4.5.3 такого кода нет. Вопрос к приёмке.

## Спеки

- 000 — заглушка.
- 001 — 4.5 ([REST и WebSocket](../../docs/spec/001-walking-skeleton.md#45-api)).
- 016 — порты `Logger` и `TraceContext`, логи 4.8.
- 003 — хранение в Postgres; 004 — расходы; 012–013 — пользователи и баланс.
