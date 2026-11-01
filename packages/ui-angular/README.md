# @swag/ui-angular

Общий Angular-пакет фронтендов платформы (спека 014, 4.7): сессия, HTTP-адаптеры портов `ui-core`. Оболочечный код, не ядро: здесь разрешены Angular и DOM. Правила ядра сюда не относятся, `arch:check` проверяет только `*-core`, `contracts` и `api-integration`.

## Задачи

- `SESSION` и `CurrentUser` — один `AuthSessionKeeper` на приложение; роль и организация из `GET /auth/me` (спека 013, D-130).
- `createRequest(session, basePath)` — REST с `Authorization: Bearer`, на `401` один `renew()` и повтор, ошибка — `HttpError`.
- `authApi`, `getMe` — адаптер `AuthApi` из `ui-core` на `fetch` по `/auth` (024, 4.15).
- `createBalanceApi(session)` — баланс организации по `/api` (013, 4.11).
- `createUsersApi(session)`, `createOrganizationsApi(session)` — порты админки и супервизора (014, 4.3) по `/auth` (024, 4.7).

Guard'ы, компоненты, тема и стили — в задачах T-7…T-8 (4.7, 4.8).

## Что внутри сейчас

- `src/http.ts` — `HttpError` (`status`, `code`; без кода в теле — `'unknown'`), `httpError(response)`, `createRequest(session, basePath)`, тип `RequestSession`.
- `src/session.ts` — `SESSION` и `CurrentUser`: `role`, `orgId`, публичный `me: Signal<AuthMe | null>` (только чтение), `ensure()`, `clear()`.
- `src/auth-api.ts` — `authApi`, `getMe(token)`.
- `src/balance-api.ts` — `createBalanceApi`, тип `BalanceApi`.
- `src/users-api.ts` — `createUsersApi`, `createOrganizationsApi`.
- `src/index.ts` — реэкспорт всего перечисленного.
- `test/http.test.ts` — AC-014-19 (403 без `renew`, `401` → `renew` → повтор, два одновременных `401` → один `renew`).
- `package.json` — `exports`: `.` → `./src/index.ts`, `./styles/*` → `./styles/*`.
- `tsconfig.json` — проверка через корневой `tsconfig.json` (`references`), поэтому `npm run typecheck` проверяет пакет. Настройки Angular — как у `apps/ui/cabinet/tsconfig.json`: `moduleResolution: bundler`, `module: preserve`, `experimentalDecorators: false`, DOM. Кабинет в корневые `references` не входит (его собирает `ng build`). Для `references` нужны `composite` и `outDir: dist` (каталог в `.gitignore`), как у `ui-core`.

## Ключевые решения

- `createRequest` не зависит от Angular: принимает `RequestSession` (`accessToken`, `renew`), тесты идут в Node без TestBed.
- Одновременные `401` делят один `renew()` внутри `createRequest` (промис хранится до завершения). Keeper из `ui-core` делит refresh ещё раз — это его собственная гарантия.
- Неудача `renew()` — ошибка `401` уходит вызывающему; выход из сессии выполняет keeper и вызывает `onSignedOut`. `createRequest` на `onSignedOut` не подписан и сам его не вызывает.
- `authApi` не использует `createRequest`: у входа и обновления нет Bearer, а `refresh` сам вызывается keeper'ом (иначе цикл).
- `HttpError` из `@swag/ui-angular` и `HttpError` из `@swag/helpers/server` (повтор с задержкой, 004) — разные классы с разными конструкторами. Импортировать каждый из своего пакета.
- Тело ошибки, которое не JSON, даёт `HttpError` с кодом `'unknown'` (раньше в кабинете это был `SyntaxError`).
- `CurrentUser.me` публичен только для чтения: `Signal` без `set` снаружи.
- `@angular/forms` 22.2.3 — явная зависимость. Без неё `npm install` не сходится: `@angular/cdk@22.2.3` требует `@angular/forms` в диапазоне `^22`, и npm берёт `22.2.4`, у которого peer `@angular/common` 22.2.4. Тот же приём, что в T-1 для `@angular/compiler-cli`.
- Версия `@angular/cdk` — 22.2.3: есть в npm (`npm view @angular/cdk@22.2.3 version`), совпадает с остальными `@angular/*`.
- Пакет подключается по workspace (`packages/*` в `package.json` корня), без `paths`: `node_modules/@swag/ui-angular` ведёт сюда.

## Ограничения

- Тестов Angular-части нет (нет TestBed-раннера). `session.ts` проверяется сборкой кабинета (`ng build`) и ручной проверкой.

## Связи

- Потребители: `apps/ui/cabinet` (`@swag/cabinet`); каркас и remote-приложения (014, 4.7).
- Использует: `@swag/ui-core` (порты, `createAuthSessionKeeper`), `@swag/contracts`.

## Спеки

- 014 — 4.7, 4.1, 4.3, AC-014-19, T-5, T-6.
- 024 — 4.15 (сессия, `/auth`).
- 013 — 4.11 (баланс, `/auth/me`, D-130).
