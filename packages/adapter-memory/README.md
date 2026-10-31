# @swag/adapter-memory

Адаптеры портов в памяти процесса: `SwarmStore` из `api-core` (роевое хранилище), `IdentityStore`, `Mailer` и `RateLimiter` из `identity-core` (спека 012). Для тестов ядер и оболочек; при перезапуске всё теряется.

## Задачи

- Реализовать асинхронный `SwarmStore` (спека 003, REQ-003-10) без базы данных — для тестов ядра и оболочки.
- Реализовать порты identity в памяти (спека 012, 4.7) для тестов `identity-core` (T-6…T-10) и общего набора тестов хранилища.
- Рабочие хранилища — `@swag/adapter-postgres` (спека 003, T-5, T-6; спека 012, T-11); этот адаптер в `apps/api` больше не используется.

## Что внутри сейчас

- `createMemorySwarmStore()` — `appendEvent`, `events`, `view`, `views`; все методы `async`.
- `createMemoryIdentityStore()` — `IdentityStore` по правилам 4.3: `createUser`, `findUserByEmail`, `findUserById`, `hasSupervisor`, `addConfirmation`, `confirmRegistration`, `createSession`, `rotateSession`, `revokeSession`. Тип `MemoryIdentityStore` — алиас `IdentityStore`, без полей сверх порта.
- `createMemoryMailer()` — `Mailer` с полем `sent: MailMessage[]` и флагом `fail`: при `true` `send` отвергает и письмо не сохраняет.
- `createMemoryRateLimiter({ now })` — `RateLimiter` с фиксированным окном; геттер `size` для проверки роста памяти.
- `test/identity-store.contract.ts` — общий набор тестов хранилища `identityStoreContract(name, makeStore)` (AC-012-30). Вызывается из `test/identity-store.test.ts` здесь и из теста Postgres-хранилища. Использует только методы `IdentityStore`; набор не требует пустой базы: токены, email и id уникальны на каждый прогон. Проверка `hasSupervisor() === false` на пустом хранилище — только в `test/identity-store.test.ts` (память).
- Тесты: `test/identity-store.test.ts` (общий набор на памяти и `hasSupervisor === false` на пустом хранилище), `test/rate-limiter.test.ts` (AC-012-14, REQ-012-17), `test/mailer.test.ts`.

## Ограничения

- Теряет все данные при перезапуске процесса.
- Повторный `seq` роя игнорируется без ошибки; недопустимое событие — reject, ничего не сохраняется.
- Идентификаторы и даты приходят снаружи (порты `IdGenerator`, `Clock`); хранилище их не генерирует.
- Не потокобезопасен сверх одного процесса. Атомарность — за счёт синхронного тела операций на одном потоке JS.
- Ограничитель: счётчики обнуляются при перезапуске (Q-6, 4.8). Очистка истёкших записей — только при `hit` и только когда записей больше 10000.
- `addConfirmation` с уже занятым `tokenHash` бросает `Error` и не перезаписывает запись, в том числе погашенную, — как первичный ключ в Postgres (трактовка 4.3, D-114).
- Ограничитель при более чем 10000 записях проходит весь `Map` на каждый `hit` (N-21).

## Связи

- Порты: `SwarmStore` из `@swag/api-core`, `IdentityStore`, `Mailer`, `RateLimiter` из `@swag/identity-core` (только типы).
- Использует: `@swag/api-core` (типы), `@swag/api-integration`, `@swag/contracts`, `@swag/identity-core`.
- Потребители: тесты `packages/api-core`, `apps/api`; тесты `identity-core` (T-6…T-10) и общий набор хранилища (T-11).

## Ключевые решения

- Один объект на роя: события (`PlatformEvent[]`) и `SwarmView` хранятся рядом, `SwarmView` обновляется через `applyEvent` при каждом `appendEvent`.
- Методы асинхронные (003, Q-1), хотя работают синхронно внутри: так один порт проверяется тестами ядра и совпадает с Postgres-адаптером.
- Хранилище identity возвращает копии записей, а не внутренние объекты: вызывающий не может изменить состояние мимо порта.
- Правила `confirmRegistration` и `rotateSession` (4.3) повторяют шаги SQL: токен подтверждения не гасится при `email_taken`; сессия с `previousHash = oldHash` отзывается при `reused`.
- Общий набор тестов — функция, а не файл `.test.ts`: Vitest его не запускает сам, его вызывают тесты адаптеров. Набор не использует внутреннее состояние адаптера, поэтому подходит и для Postgres.
- Ограничитель сверяет окно по `resetAt <= now`: запись истёкшего окна заменяется при следующем `hit` по её ключу.

## Спеки

- 001 — REQ-001-3, 4.10 (исходная реализация в памяти).
- 003 — REQ-003-10: тот же асинхронный порт, остаётся для тестов ядра.
- 012 — 4.3, 4.7, 4.8; задача T-5 (REQ-012-17, AC-012-14, AC-012-30 — память).
