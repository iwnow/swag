# @swag/ui-angular

Общий Angular-пакет фронтендов платформы (спека 014, 4.7): сессия, HTTP-адаптеры портов `ui-core`, guard'ы, компоненты. Оболочечный код, не ядро: здесь разрешены Angular и DOM. Правила ядра сюда не относятся, `arch:check` проверяет только `*-core`, `contracts` и `api-integration`.

## Задачи

Пока пакет пустой (`src/index.ts` — `export {}`). Состав по 4.7 спеки 014 переносится в следующих задачах T-6…T-8.

## Что внутри сейчас

- `src/index.ts` — пустой реэкспорт.
- `package.json` — `exports`: `.` → `./src/index.ts`, `./styles/*` → `./styles/*`. Зависимости: `@angular/core`, `@angular/common`, `@angular/router`, `@angular/cdk` (точные 22.2.3, как у Angular в кабинете), `@swag/ui-core`, `@swag/contracts`.
- `tsconfig.json` — проверка через корневой `tsconfig.json` (`references`), поэтому `npm run typecheck` проверяет пакет. Настройки Angular — как у `apps/ui/cabinet/tsconfig.json`: `moduleResolution: bundler`, `module: preserve`, `experimentalDecorators: false`, DOM. Кабинет в корневые `references` не входит (его собирает `ng build`), пакет входит, потому что его код проверяется без Angular CLI. Для `references` нужны `composite` и `outDir: dist` (каталог в `.gitignore`), как у `ui-core`.

## Ключевые решения

- Версия `@angular/cdk` — 22.2.3: есть в npm (`npm view @angular/cdk@22.2.3 version`), совпадает с остальными `@angular/*`.
- Пакет подключается по workspace (`packages/*` в `package.json` корня), без `paths`: `node_modules/@swag/ui-angular` ведёт сюда.

## Связи

- Потребители: `apps/ui/cabinet` (`@swag/cabinet`); каркас и remote-приложения 4.7.
- Использует: `@swag/ui-core` (порты и `createAuthSessionKeeper`), `@swag/contracts`.

## Спеки

- 014 — 4.7, T-5.
