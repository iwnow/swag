# @swag/adapter-postgres

Адаптер Postgres: миграции схемы роёв. Пока только `runMigrations`; хранилище `SwarmStore` на Postgres (`createPostgresSwarmStore`) появится в T-6 спеки 003.

## Задачи

- `runMigrations(databaseUrl, { schema? })` — применить миграции из `migrations/` (спека 003, 4.4, REQ-003-5). Повторный вызов ничего не меняет.
- `npm run db:migrate` в корне — то же для базы из `DATABASE_URL` с хоста (`127.0.0.1`, как у `infra:check`).

## Что внутри сейчас

- `src/index.ts` — `runMigrations`.
- `migrations/0001_swarms.sql` — таблицы `swarms` и `swarm_events` (003, 4.4), формат `-- Up Migration` / `-- Down Migration`.
- `test/migrations.test.ts` — AC-003-1; выполняется только при `POSTGRES_TEST_URL`, создаёт схему `test_<uuid>` и удаляет её в `afterAll`.

## Ограничения

- Миграции только вперёд через `runMigrations` (`direction: 'up'`); откат в коде не предусмотрен.
- Логи `node-pg-migrate` заглушены: адаптер логов не пишет (REQ-003-8).
- Схема, в которой работают миграции, должна существовать (`createSchema` не включён); для `public` это уже так.

## Связи

- Использует: `node-pg-migrate`, `pg` (тесты: `pg.Client`).
- Оболочки: `apps/api` (T-7), `scripts/db-migrate.ts`.

## Ключевые решения

- `node-pg-migrate` версии 9.0.0 (опубликована 2026-07-17, не позже чем за 2 недели до реализации; Q-2 спеки 003). Версия зафиксирована точно (`save-exact`), как у остальных зависимостей.
- Инструмент — `node-pg-migrate` (Q-2, вариант «а»): SQL-файлы, блокировка от параллельного запуска, таблица `pgmigrations`; ORM не нужен.
- `pg` версии 8.23.1, как в корневых devDependencies; объявлен и в пакете, потому что адаптер его использует напрямую. `@types/pg` — из корня.
- Таблица миграций `pgmigrations` лежит в той же схеме, что и таблицы роёв (`migrationsSchema = schema`), чтобы тестовая схема удалялась целиком.
- Каталог миграций находится через `import.meta.url`, а не через `cwd`: скрипты и `api` запускаются из разных мест.

## Спеки

- 003 — 4.4, REQ-003-5, AC-003-1 (T-5).
- 003, Q-2 — выбор инструмента миграций.
