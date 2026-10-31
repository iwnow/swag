# @swag/billing-core

Ядро баланса организации (спека 013): остаток по предоплате, пополнение, резерв бюджета роя и его закрытие по ledger. Чистый TypeScript, не знает про HTTP, Fastify, Postgres и идентификацию; всё внешнее приходит портами.

## Задачи

- Показать баланс организации: баланс, резерв (`heldMicroUsd`) и доступный остаток (`availableMicroUsd = баланс − резерв`) — `getBalance`.
- Показать журнал баланса страницами по `id` (`limit` 1…100, по умолчанию 50, `before`) — `listEntries`.
- Пополнить баланс (`topup`): администратор — своей организации, супервизор — любой существующей, с обязательным комментарием; предел суммы — `BALANCE_MAX_TOPUP_MICRO_USD`.
- Зарезервировать бюджет роя из доступного остатка (`reserve`) и закрыть резерв фактической суммой трат (`settle`) — оболочка `api` вызывает их из `api-core`.
- Проверять вызывающего по `Actor`: право (`balance.read`, `balance.topup`), область организации, существование организации у супервизора.

## Что внутри сейчас

- `createBillingCore(deps)` с портами `BalanceStore`, `OrgDirectory`, `Clock`, `Logger`, лимитом `limits.maxTopupMicroUsd`.
- Операции `getBalance`, `listEntries`, `topup` принимают `Actor` и возвращают `BillingResult`; `reserve`, `settle`, `holds` работают без `Actor` — вызывающего проверяет `api-core`.
- Правила доступа — одна функция `accessError`: `orgId` не UUID → `not_found`; нет права → `forbidden`; не супервизор и чужая организация → `not_found`.
- Логи: `balance_topup`, `balance_insufficient`, `balance_settled`, `balance_overspent` (`error`), `org_directory_unavailable` (`warn`). Контекст — только поля `LogContext` спеки 013, 4.3.
- Тесты: `test/billing-core.test.ts`. Хранилище — фейк в памяти внутри теста; `OrgDirectory`, `Clock` и `Logger` — фейки.

## Ключевые решения

- Порты `Clock` и `Logger` объявлены в ядре заново, по образцу `api-core`: ядра не импортируют друг друга (спека 013, 4.3). Оболочка передаёт один и тот же логгер.
- Порядок проверок `topup`: доступ (правила 1–3), тело по `TopupRequest`, предел суммы, комментарий супервизора, и только потом `orgs.exists`. Внешний вызов делается лишь для валидного запроса.
- Ошибка проверки организации (`orgs.exists` бросил исключение) → `org_directory_unavailable`, а не пополнение: отказ закрыт (fail closed, спека 013, раздел 7).
- Супервизор читает баланс без проверки `orgs.exists`: у несуществующей организации баланс нулевой.
- `nextBefore` — `id` последней записи страницы, если хранилище сообщило `hasMore`; иначе `null`.
- Число `before` и `limit` разбираются из строки строго: только десятичные цифры и диапазон, `Number.isSafeInteger`.

## Ограничения

- Только MVP-пополнение: виртуальные деньги, без платёжного шлюза (спека 013, «Не входит»).
- Атомарность резерва и закрытия обеспечивает хранилище (`adapter-postgres`, `adapter-memory`); ядро на атомарность не опирается и порядок вызовов не проверяет.
- Нет отрицательного баланса и наценки: эти правила держат хранилище (ограничения `check`) и спека 013.

Правила ядра ([архитектура](../../docs/architecture.md)): зависимости — `@swag/contracts` (из `CORE_ALLOWED_PACKAGES`); нет Node API, `process`, env и сети; `npm run arch:check` зелёный.

## Связи

- Оболочка: `apps/api` (в MVP собирает `billing-core` в процессе с `api-core`).
- Хранилища: `@swag/adapter-postgres` (`createPostgresBalanceStore`, T-4), `@swag/adapter-memory` (`createMemoryBalanceStore`, T-3) — в спеке 013, пока не реализованы.
- Использует: `@swag/contracts` (`OrgId`, `TopupRequest`, `BalanceView`, `BalanceEntry`, `BalanceEntryList`, `can`, `Actor`).

## Спеки

- [013. Баланс организации](../../docs/spec/013-balance.md) — разделы 4.3 (ядро), 4.1 (схемы и права), 5 (AC-013-3…7, AC-013-23).
