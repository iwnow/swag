# @swag/adapter-postgres

Адаптер Postgres: миграции схемы, хранилище роёв `SwarmStore` (порт `api-core`), бюджеты роёв и цены OpenRouter для LLM Gateway (порты `BudgetStore` и `PriceStore` из `llm-gateway-core`), хранилище identity `IdentityStore` (спеки 012 и 024: пользователи, организации, приглашения, блокировка, отзывы токенов, уборка), хранилище баланса `BalanceStore` (спека 013: баланс организации, журнал, резерв роя). Оболочка `apps/api` подключает хранилище роёв вместо адаптера в памяти.

## Задачи

- `runMigrations(databaseUrl, { schema? })` — применить миграции из `migrations/` (спека 003, 4.4, REQ-003-5; спека 004, 4.5; спека 012, 4.9; спека 013, 4.2). Повторный вызов ничего не меняет.
- `createPostgresSwarmStore(pool)` — хранилище роёв: события и проекция (`SwarmView`) пишутся одной транзакцией (REQ-003-2, 4.4).
- `createPostgresBudgetStore(pool)` — `BudgetStore` gateway (спека 004, 4.4, 4.5): регистрация роя, поиск агента, условный резерв (REQ-004-9), списание с записью ledger (REQ-004-10), закрытие роя (`close` отдаёт `spentMicroUsd` и `heldMicroUsd`), `totals` (суммы роя для ожидания списаний при закрытии, спека 013, 4.7), снятие резервов при старте.
- `createPostgresPriceStore(pool)` — `PriceStore`: последние успешные цены OpenRouter по id модели OpenRouter (спека 004, 4.5, Q-8).
- `createPostgresIdentityStore(pool)` — `IdentityStore` identity (спека 012, 4.3, 4.9; спека 024, 4.9): пользователи, организации, подтверждения регистрации, сессии, приглашения. `confirmRegistration`, `acceptInvitation`, `updateUser` и `rotateSession` — одна транзакция каждая (AC-012-9, AC-012-30, AC-024-4, AC-024-5).
- `createPostgresBalanceStore(pool)` — `BalanceStore` (спека 013, 4.2): баланс и журнал организации, пополнение (`topup`), условный резерв роя (`reserve`, REQ-013-5), закрытие резерва (`settle`) и открытые резервы (`holds`). Каждая операция записи — одна транзакция.
- `ledgerReport(pool, { swarmId?, since? })` — суммы и счётчики ledger по основанию списания и наличию факта провайдера (спека 004, 4.5, отчёт для 4.10). Формат строк `money:report` (4.13) — в T-16.
- `npm run db:migrate` в корне — `runMigrations` для базы из `DATABASE_URL` с хоста (`127.0.0.1`, как у `infra:check`).

## Что внутри сейчас

- `src/index.ts` — `runMigrations`, `createPostgresSwarmStore`, `createPostgresBudgetStore`, `createPostgresPriceStore`, `createPostgresIdentityStore`, `createPostgresBalanceStore`, `ledgerReport`, внутренние `transact`, `plainPrice`, `userFromRow`, `isEmailConflict`, `USER_COLUMNS`, `toBalanceEntry`.
- `migrations/0001_swarms.sql` — таблицы `swarms` и `swarm_events` (003, 4.4), формат `-- Up Migration` / `-- Down Migration`.
- `migrations/0002_money.sql` — `swarm_budgets`, `swarm_agents`, `budget_holds`, `ledger_entries`, `model_prices` (004, 4.5), текст из спеки без изменений.
- `migrations/0003_identity.sql` — `organizations`, `users`, `email_confirmations`, `sessions` (012, 4.9), текст из спеки без изменений. Ограничения: `users.role` — `user`, `admin`, `supervisor`; у супервизора нет `org_id`, у остальных есть.
- `migrations/0004_identity_access.sql` — `users.blocked_at`, `users.tokens_valid_after` с индексом `users_tokens_valid_after`, таблица `invitations` (024, 4.11), текст из спеки без изменений.
- `migrations/0005_billing.sql` — `org_balances`, `balance_entries`, `balance_holds` (013, 4.2), текст из спеки без изменений. Ограничения: `held <= balance`; запись `topup` с `actor_id` и без резерва, запись `swarm` с `swarm_id` и без `actor_id`; `swarm_id` в `balance_entries` уникален.
- `test/migrations.test.ts` — AC-003-1, AC-004-20 (колонки, ограничения, параллельный запуск), AC-012-3 (таблицы identity, отказы ограничений, повторный запуск), AC-024-3 (0004 вверх и вниз, данные 0003 сохраняются).
- `test/balance-store.test.ts` — общий набор `balanceStoreContract` из `adapter-memory` на Postgres (AC-013-1, AC-013-11, AC-013-12 и проверки пагинации, `insufficient`, повтора `swarmId`, `holds`) и AC-013-10 (10 параллельных резервов: ровно 3 `ok`, баланс не меняется).
- `test/store.test.ts` — AC-003-2 и AC-003-3 на `createPostgresSwarmStore`.
- `test/money.test.ts` — AC-004-13 (параллельные резервы роя и агента, закрытый рой, агент не из регистрации), AC-004-14 (списание, повтор, параллельный повтор, гонка с `releaseHolds`), AC-004-18, AC-004-32, AC-004-40 (часть хранилища); тесты `close`, `findAgent` и повторной регистрации.
- `test/identity-store.test.ts` — общий набор `identityStoreContract` из `adapter-memory` на Postgres (AC-012-30, AC-024-4) и AC-012-9 (8 параллельных подтверждений одним токеном), AC-024-5 (5 раундов параллельных `rotateSession` одним старым хэшем: ровно один `ok` и один `reused`).
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
- Деньги: все `reserve` и `settle` одного роя сериализуются на строке `swarm_budgets` — так предписывает SQL 4.5 (условный `update` держит блокировку до `commit`). NFR-004-1 в режиме 10 потоков одного роя при durable commit не выполняется; цифры и вопрос D-89 — в журнале спеки 004 (раздел 10), здесь замеров нет.
- `releaseHolds` снимает все резервы таблицы `budget_holds`, а не резервы одного роя; вызывается при старте процесса gateway до приёма запросов.
- `createPostgresIdentityStore`: `findUserById` с id, не являющимся UUID, бросает ошибку базы; память отдаёт `null`. Ядро получает id из базы или из подписанного токена, поэтому в 012 это не достижимо.
- `createPostgresIdentityStore`: `findOrganizationById` (013, 4.8) с не-UUID возвращает `null` без запроса (проверка `OrgId`), иначе `select … from organizations where id = $1`.
- `updateUser` с неизвестным `id` бросает `Error` (откат транзакции), как в памяти.
- `createPostgresBalanceStore`: `orgId` и `swarmId`, не являющиеся UUID, дают ошибку базы; проверку формата делает ядро `billing-core`.
- `purge` (024, 4.9) только удаляет; когда и как его вызывать — решает ядро (`purgeExpired`, T-9).
- `ledgerReport` с `swarmId`, не являющимся UUID, бросает ошибку базы (`invalid input syntax for type uuid`). В отличие от `view`, `events` и `close`, которые отдают `null` или `[]`, проверки формата здесь нет.

## Связи

- Порты: `SwarmStore` из `@swag/api-core`; `BudgetStore`, `PriceStore`, `LedgerEntry`, `RegisteredAgent`, `ReserveResult`, `StoredPrice` из `@swag/llm-gateway-core`; `BalanceStore` из `@swag/billing-core` (только типы).
- Использует: `@swag/api-core` (типы), `@swag/api-integration` (`applyEvent`, `SwarmView`), `@swag/contracts` (`SwarmId`, `PlatformEvent`, `LlmSwarmRegistration`, `LlmCaller`, `ChargeBasis`), `@swag/llm-gateway-core` (типы портов), `@swag/identity-core` (типы порта `IdentityStore`), `@swag/billing-core` (типы порта `BalanceStore`), `node-pg-migrate`, `pg` (тесты: `pg.Client`, `pg.Pool`). Тесты identity импортируют общий набор из `packages/adapter-memory/test/identity-store.contract.ts`.
- Оболочки: `apps/api` (T-7), `scripts/db-migrate.ts`, `apps/llm-gateway` (подключение хранилища денег — отдельной задачей спеки 004).

## Ключевые решения

- `node-pg-migrate` версии 9.0.0 (опубликована 2026-07-17, не позже чем за 2 недели до реализации; Q-2 спеки 003). Версия зафиксирована точно (`save-exact`), как у остальных зависимостей.
- Инструмент — `node-pg-migrate` (Q-2, вариант «а»): SQL-файлы, блокировка от параллельного запуска, таблица `pgmigrations`; ORM не нужен.
- `runMigrations` работает с `advisoryLockMode: 'wait'`: параллельный запуск (два `api`, тесты разных файлов) ждёт освобождения блокировки, а не падает. Блокировка node-pg-migrate общая для базы, а не для схемы. Отклонение от поведения T-5 (режим `fail` по умолчанию) — см. журнал спеки.
- `pg` версии 8.23.1, как в корневых devDependencies; объявлен и в пакете, потому что адаптер его использует напрямую. `@types/pg` — из корня.
- Таблица миграций `pgmigrations` лежит в той же схеме, что и таблицы роёв (`migrationsSchema = schema`), чтобы тестовая схема удалялась целиком.
- Каталог миграций находится через `import.meta.url`, а не через `cwd`: скрипты и `api` запускаются из разных мест.
- Проекция хранится целиком в `swarms.view` (jsonb) и обновляется при каждом событии; `swarm_events.event` — полное событие с `seq`, без разбора. `events` отдают сохранённый объект как есть, поэтому совпадают с `projectSwarm` по содержимому.
- Баланс (013, 4.2): `reserve` — условный `update` org_balances (остаток проверяется в том же запросе), при 0 строк — `insufficient` и откат без записи; повтор `swarmId` — конфликт первичного ключа в `balance_holds`, откат и исключение. `settle` — `delete ... returning` резерва: повторное закрытие даёт `null`, без записей.
- Вся логика применимости — в `applyEvent` (`api-integration`), адаптер только вызывает её внутри транзакции: одинаково с адаптером в памяти.

## Деньги (спека 004)

- Одна транзакция на операцию: `transact(pool, work)` берёт клиента, `begin`, `work` возвращает `{ commit, value }`. `commit: false` откатывает — так отказ по бюджету не оставляет частичного резерва. Ошибка — `rollback`, сбой rollback выбрасывает клиента через `release(true)`, как в `writeOnce`.
- `reserve`: сначала условный `update` роя, потом агента, потом вставка в `budget_holds`. Условный `update` берёт блокировку строки, поэтому параллельные резервы одного роя выстраиваются в очередь без `for update`. Агент не найден в `swarm_agents` → `agent_budget_exceeded`: ядро проверяет агента через `findAgent` раньше, так что до адаптера это не доходит.
- `settle` — отклонение от порядка шагов 4.5, сделано ради AC-004-14: запись в `ledger_entries` (`on conflict (call_id) do nothing`) идёт первой. Если строка не вставилась (повтор того же `callId`), транзакция откатывается и `spent` не меняется. По порядку из 4.5 повтор увеличивал бы `spent`, потому что резерв уже удалён. Резерва нет — `held` не меняется, трата и запись пишутся.
- `register` — рой и агенты в одной транзакции; повтор `swarmId` — `false`, ничего не пишется (`on conflict (swarm_id) do nothing`).
- `close` — `closed_at = coalesce(closed_at, $now)`: повтор не переписывает время и отдаёт тот же `spent` (4.2). Возвращает и `held_micro_usd` (013, 4.7). Неизвестный рой — `null`. `swarmId`, не являющийся UUID, — `null` без запроса.
- `totals` — `select spent_micro_usd, held_micro_usd from swarm_budgets` для ожидания списаний при закрытии (013, 4.7); неизвестный рой и не UUID — `null`.
- `findAgent` — строка `swarm_agents` с `expires_at` и `closed` (`closed_at is not null`) роя из `swarm_budgets`; срок и закрытие проверяет ядро.
- `releaseHolds` — удаляет все строки `budget_holds` и уменьшает `held` роёв и агентов на их суммы одной транзакцией. Вызывается ядром до приёма запросов (AC-004-18); записей ledger не пишет.
- Цены: `numeric(9, 4)` в базе, строка `PricePerMTok` в порту. Чтение обрезает незначащие нули (`"3.0000"` → `"3"`, `plainPrice`), запись отдаёт строку в SQL без `Number`. `save` — `insert … on conflict (open_router_model) do update` в одной транзакции.
- `ledgerReport` — один запрос с `group by basis` и условными агрегатами; итоги и `byBasis` (все три основания, даже пустые) считаются в коде. Фильтр по рою и по `ts >= since` — параметры, не склейка строк. `bigint` приходят строками и переводятся в `number`; граница — `Number.MAX_SAFE_INTEGER` micro-USD (около $9·10⁹ суммарно по выборке). Выше этого порога перевод в `number` потеряет точность.
- Миграция `0002_money.sql` — текст 4.5 без изменений; у `ledger_entries` нет внешнего ключа на `swarm_budgets` (запись живёт дольше бюджета).

## Identity (спека 012)

- Транзакция через `transact` только у `confirmRegistration` и `rotateSession`; остальные операции — один запрос. У памяти и Postgres общий набор сценариев (`identityStoreContract`), семантика совпадает.
- `acceptInvitation` (024): та же схема, что у `confirmRegistration`, по таблице `invitations`: погашение `used_at` с проверкой срока, при занятом email — `rollback` и `email_taken`; пользователь получает `role` и `org_id` приглашения. Организация читается отдельным запросом в той же транзакции.
- `updateUser` (024): одна транзакция. Непереданные поля не меняются через `coalesce` и флаг `blocked_at`; с `revokeAt` — `tokens_valid_after` и `revoked_at = revokeAt` у сессий с `revoked_at is null`.
- `listUsers` — `org_id = $1` или все, сортировка по email; `listOrganizations` — `left join` и `count`, сортировка по name; `tokenRevocations` — `tokens_valid_after > $1`; `purge` — три `delete` по `expires_at < $1` и `revoked_at < $1`.
- `confirmRegistration`: `update email_confirmations set used_at = $now where token_hash = $1 and used_at is null and expires_at > $now returning email`. Блокировка строки — в самом `update`, без `for update`. Параллельные подтверждения одним токеном: проигравший после `commit` победителя не находит строку с `used_at is null` → `invalid_token`. Ровно один `ok` (AC-012-9).
- `email_taken` — `rollback`: токен не гасится, организация и пользователь не создаются. Занятый email проверяется запросом; гонку двух регистраций одного email закрывает уникальный индекс `users_email_key` (код `23505`), нарушение — тот же `rollback` и `email_taken`. Другие ошибки пробрасываются.
- `rotateSession`: найденная живая сессия по `refresh_hash` — `for update`; `previous_hash = refresh_hash` и новый хэш в одном `update`. Не найдена — поиск по `previous_hash` с `for update`; найдена — `revoked_at = now` и `commit`, чтобы отзыв сохранился (`reused`). Иначе `invalid`, без записи. Параллельный повтор одного токена после победителя попадает в ветку `reused`.
- `addConfirmation` при занятом `token_hash` — ошибка первичного ключа, запись не перезаписывается, в том числе погашенная (D-114, вариант а). `createUser` с занятым email — ошибка уникального индекса (как в памяти).
- Времена порта — мс эпохи; в запросы передаются `Date`, из базы читаются через `getTime()`. `revokeSession` — одна строка `update`.

## Спеки

- 003 — 4.4, REQ-003-1, REQ-003-2, REQ-003-5, REQ-003-8, AC-003-1, AC-003-2, AC-003-3, NFR-003-2 (T-5, T-6).
- 003, Q-2 — выбор инструмента миграций.
- 004 — 4.4 и 4.5 (хранилище), REQ-004-9, REQ-004-10, AC-004-13, AC-004-14, AC-004-18 (хранилище), AC-004-20, AC-004-32, AC-004-40 (хранилище), NFR-004-1 (T-3).
- 012 — 4.3 (хранилище), 4.9 (миграция 0003), AC-012-3, AC-012-9, AC-012-30 (T-11); D-114.
- 024 — 4.9 (хранилище), 4.11 (миграция 0004); задачи T-4 (AC-024-3), T-5, T-6 (AC-024-4, AC-024-5). Гонка `rotateSession` (N-22): SQL 012 уже закрывает её, правок не потребовалось.
