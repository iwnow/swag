# @swag/adapter-memory

Адаптеры портов в памяти процесса: `SwarmStore` из `api-core` (роевое хранилище), `IdentityStore`, `Mailer` и `RateLimiter` из `identity-core` (спеки 012 и 024), `BalanceStore` из `billing-core` (спека 013), `JobStore` из `scheduler-core` и `ProcessStore` из `api-core` (спека 033). Для тестов ядер и оболочек; при перезапуске всё теряется.

## Задачи

- Реализовать асинхронный `SwarmStore` (спека 003, REQ-003-10) без базы данных — для тестов ядра и оболочки.
- Реализовать порты identity в памяти (спека 012, 4.7) для тестов `identity-core` (T-6…T-10) и общего набора тестов хранилища.
- Реализовать методы доступа порта `IdentityStore` (спека 024, 4.9, T-5): пользователи, блокировка, приглашения, организации, отзывы, уборка.
- Реализовать `BalanceStore` в памяти (спека 013, 4.2, T-3) с той же семантикой, что у Postgres, для тестов `billing-core` и общего набора тестов хранилища баланса.
- Реализовать `JobStore` (задания и запуски планировщика, спека 033, 4.7, T-10) и `ProcessStore` (определения процессов, 4.6) в памяти — для тестов `scheduler-core` и `api-core`, с общими наборами тестов.
- Порты узлов без узлов (спека 026, 4.10) — `createMemoryNodePorts`: пустой реестр, песочница не создаётся. Для оболочек и тестов без узлов.
- Рабочие хранилища — `@swag/adapter-postgres` (спека 003, T-5, T-6; спека 012, T-11); этот адаптер в `apps/api` больше не используется.

## Что внутри сейчас

- `createMemorySwarmStore()` — `appendEvent`, `events`, `view`, `views`; все методы `async`.
- `createMemoryIdentityStore()` — `IdentityStore` по правилам 4.3 и 4.9: `createUser`, `findUserByEmail`, `findUserById`, `hasSupervisor`, `addConfirmation`, `confirmRegistration`, `createSession`, `rotateSession`, `revokeSession`, `listUsers`, `updateUser` (с `revokeAt` отзывает живые сессии пользователя), `addInvitation`, `acceptInvitation`, `listOrganizations`, `findOrganizationById` (013, 4.8), `tokenRevocations`, `purge`. Тип `MemoryIdentityStore` — алиас `IdentityStore`, без полей сверх порта.
- `createMemoryMailer()` — `Mailer` с полем `sent: MailMessage[]` и флагом `fail`: при `true` `send` отвергает и письмо не сохраняет.
- `createMemoryRateLimiter({ now })` — `RateLimiter` с фиксированным окном; геттер `size` для проверки роста памяти.
- `test/identity-store.contract.ts` — общий набор тестов хранилища `identityStoreContract(name, makeStore)` (AC-012-30, AC-024-4, AC-013-20 для `findOrganizationById`). Вызывается из `test/identity-store.test.ts` здесь и из теста Postgres-хранилища. Использует только методы `IdentityStore`; набор не требует пустой базы: токены, email и id уникальны на каждый прогон. Проверка `hasSupervisor() === false` на пустом хранилище — только в `test/identity-store.test.ts` (память).
- `createMemoryBalanceStore()` — `BalanceStore` (спека 013, 4.2): `balance`, `entries`, `topup`, `reserve`, `settle`, `holds`. Строка организации появляется при первом пополнении; `id` записей — общий счётчик от 1 на все организации; `ts` — строка как передана. Каждая операция синхронна внутри async-функции: проверка и запись не разделены `await`.
- `createMemorySecretStore()` — `SecretStore` из `api-core` (спека 026, 4.6, T-8): `list`, `put`, `delete` по организации. Значение секрета не хранит — только имя, подсказку и время обновления; подсказка — последние 4 символа при длине значения от 16, иначе `null`, как в Postgres. `list` отдаёт список, отсортированный по имени.
- `createMemoryNodePorts()` — порты узлов без узлов (спека 026, 4.10): пустой реестр, песочница не создаётся.
- `createMemoryJobStore()` — `JobStore` (спека 033, 4.7, 4.8): `put`, `get`, `getMany`, `delete` (запуски каскадом), `claimDue` с арендой, `recordTick` (курсор, поля и запуски одной операцией), `enqueue`, `counts`, `takeQueued`, `setRun`, `cancelQueued`, `byStatus`, `runs`. Аренда — внутреннее поле хранилища, в `JobRecord` её нет.
- `createMemoryProcessStore()` — `ProcessStore` (спека 033, 4.6): `create`, `update`, `get`, `list` (`null` — все организации; по `updatedAt` по убыванию), `count`, `delete`.
- `test/job-store.cases.ts` и `test/process-store.cases.ts` — общие наборы `jobStoreCases(name, makeStore, makeSecond?)` и `processStoreCases(name, makeStore, makeOwner?)` (AC-033-11): свойства каждого метода, конкурентный `claimDue` и `takeQueued` через `makeSecond`, атомарность `recordTick`. Вызываются из `test/job-store.test.ts` и `test/process-store.test.ts` здесь и из тестов Postgres (T-11). Проверки идут по своим id, поэтому набор не требует пустой базы. Задание, созданное через `putJob`, удаляется в `afterEach` (запуски каскадом), чтобы общая база не копила мусор и не вытесняла свои строки из `claimDue(…, 1000)` и `takeQueued(1000)`.
- Контракт наборов для адаптеров (Postgres — T-11): `claimDue` отдаёт задания по `nextRunAt`; `takeQueued` и `byStatus` — запуски по `createdAt`; `runs` — по `createdAt` по убыванию. `RETURNING` в Postgres порядок не гарантирует, поэтому адаптер Postgres сортирует результат сам. `counts` содержит запись для каждого запрошенного id (нули для пустых). Даты в записях — строки `toISOString()`. Тест двух соединений на Postgres идёт через `makeSecond` на втором соединении пула.
- `test/balance-store.contract.ts` — общий набор `balanceStoreContract(name, makeStore)` (AC-013-1, AC-013-11, AC-013-12 и проверки пагинации, `insufficient`, повтора `swarmId`, `holds`). Вызывается из `test/balance-store.test.ts` здесь и из теста Postgres-хранилища баланса.
- Тесты: `test/identity-store.test.ts` (общий набор на памяти и `hasSupervisor === false` на пустом хранилище), `test/rate-limiter.test.ts` (AC-012-14, REQ-012-17), `test/mailer.test.ts`.

## Ограничения

- Теряет все данные при перезапуске процесса.
- Повторный `seq` роя игнорируется без ошибки; недопустимое событие — reject, ничего не сохраняется.
- Идентификаторы и даты приходят снаружи (порты `IdGenerator`, `Clock`); хранилище их не генерирует.
- Не потокобезопасен сверх одного процесса. Атомарность — за счёт синхронного тела операций на одном потоке JS.
- Ограничитель: счётчики обнуляются при перезапуске (Q-6, 4.8). Очистка истёкших записей — только при `hit` и только когда записей больше 10000.
- `addConfirmation` и `addInvitation` с уже занятым `tokenHash` бросают `Error` и не перезаписывают запись, в том числе погашенную, — как первичный ключ в Postgres (трактовка 4.3, D-114).
- `updateUser` с неизвестным `id` бросает `Error`; проверку существования делает ядро до вызова.
- Ограничитель при более чем 10000 записях проходит весь `Map` на каждый `hit` (N-21).
- Баланс: `balance` для организации без строки отдаёт нули; `reserve` и `settle` не проверяют формат `orgId` и `swarmId` (проверяет ядро); `settle` без открытого резерва отдаёт `null`.
- Задания: `recordTick` и `enqueue` для несуществующего задания, а также занятый id запуска бросают `Error`; `recordTick` проверяет запуски до записи, поэтому при сбое курсор не меняется. `setRun` для неизвестного id ничего не делает, как `UPDATE` без строк в Postgres.
- `ProcessStore.update` для неизвестного id бросает `Error` (как `updateUser`; трактовка — D-185).

## Связи

- Порты: `SwarmStore` из `@swag/api-core`, `IdentityStore`, `Mailer`, `RateLimiter` из `@swag/identity-core`, `BalanceStore` из `@swag/billing-core` (только типы), `SecretStore` из `@swag/api-core` (тип порта).
- Использует: `@swag/api-core` (типы), `@swag/api-integration`, `@swag/billing-core` (типы), `@swag/contracts`, `@swag/identity-core`, `@swag/scheduler-core` (типы `JobStore`, `JobRecord`, `RunRecord`, `TickRecord`).
- Потребители: тесты `packages/api-core`, `apps/api`; тесты `identity-core` (T-6…T-10) и общий набор хранилища (T-11); тесты `billing-core` и общий набор хранилища баланса (спека 013).

## Ключевые решения

- Один объект на роя: события (`PlatformEvent[]`) и `SwarmView` хранятся рядом, `SwarmView` обновляется через `applyEvent` при каждом `appendEvent`.
- Баланс (013, 4.2): порядок проверок в `reserve` повторяет SQL — сначала остаток, потом повтор `swarmId`; так при нехватке денег повтор не даёт исключения, как и в Postgres.
- Методы асинхронные (003, Q-1), хотя работают синхронно внутри: так один порт проверяется тестами ядра и совпадает с Postgres-адаптером.
- Хранилище identity возвращает копии записей, а не внутренние объекты: вызывающий не может изменить состояние мимо порта.
- Правила `confirmRegistration` и `rotateSession` (4.3) повторяют шаги SQL: токен подтверждения не гасится при `email_taken`; сессия с `previousHash = oldHash` отзывается при `reused`.
- Общий набор тестов — функция, а не файл `.test.ts`: Vitest его не запускает сам, его вызывают тесты адаптеров. Набор не использует внутреннее состояние адаптера, поэтому подходит и для Postgres.
- Ограничитель сверяет окно по `resetAt <= now`: запись истёкшего окна заменяется при следующем `hit` по её ключу.
- Задания (033, 4.7): аренда свободна, когда `leaseUntil < now` (равенство — ещё занята). Времена сравниваются через `Date.parse`, `nextRunAt = null` в `claimDue` не попадает. `put` аренду не трогает: она не часть `JobRecord`, снимается `recordTick` и `delete`.
- Копии (033, 4.6–4.7): записи отдаются и принимаются через `JSON`-копию, включая `lastError` в `recordTick`, а не `structuredClone`: `structuredClone` в `lib` проекта не объявлен (`lib: ES2023`, `types: []`), а записи состоят из JSON-данных (событие запуска — из JSON-запроса). Поле со значением `undefined` в записи пропадёт; запуски и задания приходят из JSON, поэтому поведение не меняется.
- Сортировка запусков по `createdAt` стабильна: при равных временах порядок — порядок постановки.

## Спеки

- 001 — REQ-001-3, 4.10 (исходная реализация в памяти).
- 003 — REQ-003-10: тот же асинхронный порт, остаётся для тестов ядра.
- 012 — 4.3, 4.7, 4.8; задача T-5 (REQ-012-17, AC-012-14, AC-012-30 — память).
- 024 — 4.9, 4.11; задачи T-5 (AC-024-4 — память, `test/identity-store.contract.ts`).
- 026 — 4.6, T-8: `createMemorySecretStore` (реализация `SecretStore`).
- 033 — 4.6, 4.7, 4.8; задача T-10 (AC-033-11 — память): `createMemoryJobStore`, `createMemoryProcessStore`, `test/job-store.cases.ts`, `test/process-store.cases.ts`.
