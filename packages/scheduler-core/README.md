# @swag/scheduler-core

Ядро планировщика процессов: задания по триггерам, аренда и такт, очередь запусков, перенос запуска в `api` и исполнение узлов процесса-триггера (спека 033, 4.7). Чистый TypeScript: БД, HTTP и часы подключает оболочка `apps/scheduler` через порты.

## Задачи

- Держать задание на процесс: включение, выключение с причиной, замена спеки, удаление, состояние (`putJob`, `enable`, `disable`, `deleteJob`, `states`) — T-14.
- Ставить запуски в очередь с ограничением `queueMax`, отдавать историю запусков (`createRun`, `runs`) — T-14.
- Такт: опрос расписаний и внешних триггеров с арендой, перенос запусков в `api`, синхронизация статусов, восстановление после сбоя (`tick`, `recover`) — T-15, T-16.

## Что внутри сейчас

- Каркас: типы и порты из спеки 4.7 — `JobRecord`, `RunRecord`, `TickRecord`, `JobStore`, `ApiClient`, `NodeInvoker`, `RootSpans`, `SchedulerCoreDeps`, `SchedulerCore`, `CronSchedule`; `Clock`, `IdGenerator`, `Logger` объявлены здесь же, как в `orchestrator-core`.
- `PROCESS_TICK_BATCH = 20` — число заданий за один такт.
- `createSchedulerCore(deps)` — фабрика; все операции пока бросают `not implemented`.
- Тестов пока нет: поведение появляется с T-14…T-16.

## Ограничения

- Зависимости — только `@swag/contracts` (белый список правил ядра разрешает также `zod` и `@swag/api-integration`; их подключит задача, которой они понадобятся, — `nextScheduleRun` в T-14).
- Ядро не читает env и не знает о БД: `JobStore`, `ApiClient`, `NodeInvoker`, `CronSchedule` приходят портами.

## Связи

- Типы процесса, задания и запуска: `@swag/contracts` (`process.ts`, `node-invocation.ts`, `swarm.ts`).
- Порт `CronSchedule` — адаптер `@swag/adapter-croner`.
- Оболочка: `apps/scheduler` (T-17). Хранилища: `adapter-memory` (T-10), `adapter-postgres` (T-11). Клиент `api` — `adapter-api-http` (T-13), вызов узлов — `adapter-orchestrator-http` (T-12).

## Ключевые решения

- Порты повторяют 4.7 спеки без изменений; `Clock`, `IdGenerator`, `Logger` объявлены в ядре, как в `orchestrator-core`, чтобы оболочка передавала одни и те же адаптеры.
- Заглушки бросают исключение, а не возвращают значение по умолчанию: вызов до T-14 не должен тихо дать неверный результат.

## Спеки

- 033 — 4.5, 4.7; задача T-9. Основа для T-14…T-16.
