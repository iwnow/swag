# @swag/adapter-postgres

Адаптер Postgres: миграции схемы, хранилище роёв `SwarmStore` (порт `api-core`), бюджеты роёв и цены OpenRouter для LLM Gateway (порты `BudgetStore` и `PriceStore` из `llm-gateway-core`). Оболочка `apps/api` подключает хранилище роёв вместо адаптера в памяти.

## Задачи

- `runMigrations(databaseUrl, { schema? })` — применить миграции из `migrations/` (спека 003, 4.4, REQ-003-5; спека 004, 4.5). Повторный вызов ничего не меняет.
- `createPostgresSwarmStore(pool)` — хранилище роёв: события и проекция (`SwarmView`) пишутся одной транзакцией (REQ-003-2, 4.4).
- `createPostgresBudgetStore(pool)` — `BudgetStore` gateway (спека 004, 4.4, 4.5): регистрация роя, поиск агента, условный резерв (REQ-004-9), списание с записью ledger (REQ-004-10), закрытие роя, снятие резервов при старте.
- `createPostgresPriceStore(pool)` — `PriceStore`: последние успешные цены OpenRouter по id модели OpenRouter (спека 004, 4.5, Q-8).
- `ledgerReport(pool, { swarmId?, since? })` — суммы и счётчики ledger по основанию списания и наличию факта провайдера (спека 004, 4.5, отчёт для 4.10). Формат строк `money:report` (4.13) — в T-16.
- `npm run db:migrate` в корне — `runMigrations` для базы из `DATABASE_URL` с хоста (`127.0.0.1`, как у `infra:check`).

## Что внутри сейчас

- `src/index.ts` — `runMigrations`, `createPostgresSwarmStore`, `createPostgresBudgetStore`, `createPostgresPriceStore`, `ledgerReport`, внутренние `transact` и `plainPrice`.
- `migrations/0001_swarms.sql` — таблицы `swarms` и `swarm_events` (003, 4.4), формат `-- Up Migration` / `-- Down Migration`.
- `migrations/0002_money.sql` — `swarm_budgets`, `swarm_agents`, `budget_holds`, `ledger_entries`, `model_prices` (004, 4.5), текст из спеки без изменений.
- `test/migrations.test.ts` — AC-003-1, AC-004-20 (колонки, ограничения, параллельный запуск).
- `test/store.test.ts` — AC-003-2 и AC-003-3 на `createPostgresSwarmStore`.
- `test/money.test.ts` — AC-004-13 (параллельные резервы, роя и агента), AC-004-14, AC-004-18, AC-004-32, AC-004-40 (часть хранилища); тесты `close`, `findAgent` и повторной регистрации.
- `test/bench.test.ts` — замер NFR-003-2 (1000 событий одного роя, p50 и p95 в stdout, без порога).
- `test/bench-money.test.ts` — замер NFR-004-1: 1000 пар `reserve`+`settle` последовательно и 1000 пар в 10 потоках одного роя, p50 и p95 в stdout.

Все тесты пишутся в схему `test_<uuid>` на файл и удаляют её в `afterAll`; без `POSTGRES_TEST_URL` пропускаются, бенчи дополнительно требуют `POSTGRES_BENCH=1`. Тест, которому нужна пустая таблица `budget_holds` (`releaseHolds` снимает все резервы), работает в собственной схеме.

## Устройство `appendEvent`

- Клиент берётся из пула (`pool.connect()`), `begin`, затем: `select view from swarms where id = $1 for update` (блокировка проекции роя), `applyEvent(current, event)`.
- Исключение `applyEvent` (событие до `swarm.created`, повторный `swarm.created`) — `rollback` и reject тем же исключением; ничего не записано.
- Повтор `seq` — `applyEvent` возвращает ту же проекцию: `commit` без записи.
- Иначе: `insert into swarms` для `swarm.created`, `update swarms` для остальных; затем `insert into swarm_events`; `commit`.
- `for update` сериализует записи уже существующего роя на уровне базы, поэтому порядок `seq` держится и при нескольких экземплярах процессов; очередь записи в `api-core` (REQ-003-3) остаётся основной гарантией.
- Создание роя `for update` не блокирует (строки ещё нет). Гонку двух `swarm.created` одного роя закрывает `insert ... on conflict (id) do nothing returning id`: если строка не вернулась, проигравший откатывает транзакцию и повторяет запись один раз. При повторе `for update` видит созданный рой, и `applyEvent` даёт тихий успех на тот же `seq` или исключение на чужое событие. Повтор — один, без цикла.
- Сбой `rollback` не скрывает исходную ошибку: клиент возвращается в пул через `release(true)` (соединение выбрасывается), наружу уходит исходная ошибка. Клиент освобождается ровно один раз, в `finally`.

## Проверка UUID

`swarmId`, не являющийся UUID, даёт `view` → `null` и `events` → `[]` без обращения к базе. Проверка — `SwarmId` из `@swag/contracts` (`z.uuid()`), тот же формат, что у событий.

## Схема и подключение

- Адаптер не вшивает имена схем в SQL: таблицы находятся через `search_path` подключения. Тесты задают его через `options: '-c search_path=<schema>'` в конфиге пула.
- Оболочка `apps/api` (T-7) создаёт пул с обычным `connectionString`, схема — `public`.

## Ограничения

- Миграции только вперёд через `runMigrations` (`direction: 'up'`); откат в коде не предусмотрен.
- Логи адаптера не пишутся: ни `node-pg-migrate`, ни запросы (REQ-003-8). Текст событий в логах не появляется.
- Схема, в которой работают миграции, должна существовать (`createSchema` не включён); для `public` это уже так.
- Ошибки базы (недоступна, нарушение ограничений) пробрасываются как есть; адаптер ничего не повторяет.
- Список `views()` без сортировки и без пагинации (Q-3); порядок сортирует `api-core`.
- Не потокобезопасен сверх возможностей пула: одна запись роя — одна транзакция, разные рои пишутся параллельно.

## Связи

- Порты: `SwarmStore` из `@swag/api-core`; `BudgetStore`, `PriceStore`, `LedgerEntry`, `RegisteredAgent`, `ReserveResult`, `StoredPrice` из `@swag/llm-gateway-core` (только типы).
- Использует: `@swag/api-core` (типы), `@swag/api-integration` (`applyEvent`, `SwarmView`), `@swag/contracts` (`SwarmId`, `PlatformEvent`, `LlmSwarmRegistration`, `LlmCaller`, `ChargeBasis`), `@swag/llm-gateway-core` (типы портов), `node-pg-migrate`, `pg` (тесты: `pg.Client`, `pg.Pool`).
- Оболочки: `apps/api` (T-7), `scripts/db-migrate.ts`, `apps/llm-gateway` (подключение хранилища денег — отдельной задачей спеки 004).

## Ключевые решения

- `node-pg-migrate` версии 9.0.0 (опубликована 2026-07-17, не позже чем за 2 недели до реализации; Q-2 спеки 003). Версия зафиксирована точно (`save-exact`), как у остальных зависимостей.
- Инструмент — `node-pg-migrate` (Q-2, вариант «а»): SQL-файлы, блокировка от параллельного запуска, таблица `pgmigrations`; ORM не нужен.
- `runMigrations` работает с `advisoryLockMode: 'wait'`: параллельный запуск (два `api`, тесты разных файлов) ждёт освобождения блокировки, а не падает. Блокировка node-pg-migrate общая для базы, а не для схемы. Отклонение от поведения T-5 (режим `fail` по умолчанию) — см. журнал спеки.
- `pg` версии 8.23.1, как в корневых devDependencies; объявлен и в пакете, потому что адаптер его использует напрямую. `@types/pg` — из корня.
- Таблица миграций `pgmigrations` лежит в той же схеме, что и таблицы роёв (`migrationsSchema = schema`), чтобы тестовая схема удалялась целиком.
- Каталог миграций находится через `import.meta.url`, а не через `cwd`: скрипты и `api` запускаются из разных мест.
- Проекция хранится целиком в `swarms.view` (jsonb) и обновляется при каждом событии; `swarm_events.event` — полное событие с `seq`, без разбора. `events` отдают сохранённый объект как есть, поэтому совпадают с `projectSwarm` по содержимому.
- Вся логика применимости — в `applyEvent` (`api-integration`), адаптер только вызывает её внутри транзакции: одинаково с адаптером в памяти.

## Деньги (спека 004)

- Одна транзакция на операцию: `transact(pool, work)` берёт клиента, `begin`, `work` возвращает `{ commit, value }`. `commit: false` откатывает — так отказ по бюджету не оставляет частичного резерва. Ошибка — `rollback`, сбой rollback выбрасывает клиента через `release(true)`, как в `writeOnce`.
- `reserve`: сначала условный `update` роя, потом агента, потом вставка в `budget_holds`. Условный `update` берёт блокировку строки, поэтому параллельные резервы одного роя выстраиваются в очередь без `for update`. Агент не найден в `swarm_agents` → `agent_budget_exceeded`: ядро проверяет агента через `findAgent` раньше, так что до адаптера это не доходит.
- `settle` — отклонение от порядка шагов 4.5, сделано ради AC-004-14: запись в `ledger_entries` (`on conflict (call_id) do nothing`) идёт первой. Если строка не вставилась (повтор того же `callId`), транзакция откатывается и `spent` не меняется. По порядку из 4.5 повтор увеличивал бы `spent`, потому что резерв уже удалён. Резерва нет — `held` не меняется, трата и запись пишутся.
- `register` — рой и агенты в одной транзакции; повтор `swarmId` — `false`, ничего не пишется (`on conflict (swarm_id) do nothing`).
- `close` — `closed_at = coalesce(closed_at, $now)`: повтор не переписывает время и отдаёт тот же `spent` (4.2). Неизвестный рой — `null`. `swarmId`, не являющийся UUID, — `null` без запроса.
- `findAgent` — строка `swarm_agents` с `expires_at` и `closed` (`closed_at is not null`) роя из `swarm_budgets`; срок и закрытие проверяет ядро.
- `releaseHolds` — удаляет все строки `budget_holds` и уменьшает `held` роёв и агентов на их суммы одной транзакцией. Вызывается ядром до приёма запросов (AC-004-18); записей ledger не пишет.
- Цены: `numeric(9, 4)` в базе, строка `PricePerMTok` в порту. Чтение обрезает незначащие нули (`"3.0000"` → `"3"`, `plainPrice`), запись отдаёт строку в SQL без `Number`. `save` — `insert … on conflict (open_router_model) do update` в одной транзакции.
- `ledgerReport` — один запрос с `group by basis` и условными агрегатами; итоги и `byBasis` (все три основания, даже пустые) считаются в коде. Фильтр по рою и по `ts >= since` — параметры, не склейка строк. `bigint` приходят строками и переводятся в `number`; граница — `Number.MAX_SAFE_INTEGER` micro-USD (около $9·10⁹ суммарно по выборке). Выше этого порога перевод в `number` потеряет точность.
- Миграция `0002_money.sql` — текст 4.5 без изменений; у `ledger_entries` нет внешнего ключа на `swarm_budgets` (запись живёт дольше бюджета).

## Спеки

- 003 — 4.4, REQ-003-1, REQ-003-2, REQ-003-5, REQ-003-8, AC-003-1, AC-003-2, AC-003-3, NFR-003-2 (T-5, T-6).
- 003, Q-2 — выбор инструмента миграций.
- 004 — 4.4 и 4.5 (хранилище), REQ-004-9, REQ-004-10, AC-004-13, AC-004-14, AC-004-18 (хранилище), AC-004-20, AC-004-32, AC-004-40 (хранилище), NFR-004-1 (T-3).
