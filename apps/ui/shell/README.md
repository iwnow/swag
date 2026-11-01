# @swag/shell

Каркас фронтендов платформы: вход, регистрация, приглашение, шапка с навигацией и подгрузка микрофронтендов по правам. Спека 014, раздел 4.4 и 4.11.

## Что это и зачем

Каркас — Angular-приложение, которое хозяин сессии: восстанавливает её по cookie, показывает страницы входа и шапку, а разделы `cabinet`, `admin`, `supervisor` подгружает как Native Federation remote во время работы. Раздел без прав не загружается вовсе (REQ-014-3). Права в интерфейсе считает `@swag/ui-core` по `GET /auth/me`; доступ проверяет API.

## Что внутри сейчас (T-24)

- `src/main.ts` — `initFederation({})` без remote, затем `bootstrap.ts` (динамический импорт нужен, чтобы общие модули уже были в import map).
- `src/app/app.ts` — корень: тема (`SHELL_STORE.theme` → атрибут `data-theme` на `<html>`) применяется и на `/login`; переход с «вошёл» на «вышел» (`SESSION_USER.status`) ведёт на `/login`, первичное «вышел» уводит через guard; на `NavigationEnd` — `SESSION_USER.ensureMe()` (смена токена, D-146); alert «Раздел недоступен» (4.6) — здесь, вне Layout, сбрасывается на `NavigationEnd`.
- `src/app/app.config.ts` — маршрутизатор и `provideShellStore()` (мост `ShellStore`, 014, 4.12).
- `src/app/app.routes.ts` — `/login` и раздел под `sessionGuard` с `LayoutComponent`; `admin` и `supervisor` — под `areaGuard`; `cabinet` — `''`; `**` → `''`.
- `src/app/remote-registry.ts` — сервис `RemoteRegistry`: чтение `/federation.manifest.json`, отбрасывание адресов вне `isLocalRemoteUrl` с `console.warn('remote_rejected', name)`, `loadRoutes(name)` — `loadRemoteModule` на `./routes`.
- `src/app/layout.ts` — шапка по REQ-014-10: пункты `SESSION_USER.navigation`, email и организация из `SESSION_USER.me`, тема (`SHELL_STORE.theme`, `setTheme`), «Выйти» (`SHELL_STORE.logout`).
- `src/app/login.page.ts` — `/login?returnTo=`: поля на `swag-field`; форма и вход — `SHELL_STORE.form()` и `SHELL_STORE.login(email, password, returnTo)`; результат не `null` — переход на него. Уже открытая сессия (`SESSION_USER.restore()`) сразу уводит на `returnTo`.
- `public/federation.manifest.json` — только `cabinet`; записи `admin` и `supervisor` появляются с T-15 и T-16.
- `federation.config.mjs`, `tsconfig*.json`, `angular.json` — конфиг из журнала T-1 (`spike-shell`, переименован в `shell`), с двумя уточнениями, см. ниже.
- `proxy.conf.json` — `/api`, `/auth`, `/grafana` и `/mf/<имя>` на контейнеры compose (4.9).

## Как запускать

- `npm run start` в `apps/ui/shell` — `ng serve --configuration container`: host `0.0.0.0`, порт `4200`. Так работает образ `Dockerfile`.
- `npx ng build` — сборка каркаса с `remoteEntry.json` и манифестом в `dist/shell/browser`.

До T-12 remote `cabinet` не собран, поэтому раздел `/` показывает «Раздел недоступен» (ожидаемо, в журнале спеки).

## Ключевые решения

- **Native Federation** (Q-1, 014): `shareAll` с `singleton`, `strictVersion`, `requiredVersion: 'auto'`; `@swag/*` — через `sharedMappings` (исходники TS).
- **`skipList`:** `NG_SKIP_LIST`, `@angular/build|cli|compiler-cli`, `@swag/*` и `@angular/cdk/schematics` (D-141). Без последнего сборка падает: entry point `schematics` тянет `@angular-devkit/core`, которого не бандлит browser-shared.
- **`@angular/cdk` и `@angular/forms` в `package.json`** каркаса: без них `shareAll` не делит их между каркасом и remote, а `swag-confirm` использует `Dialog` из cdk (D-142).
- **`ng serve --host` не работает** с builder'ом `serve` Native Federation (схема его не знает). Host и порт задаются в `serve-original`; `container` — конфигурация для контейнера. Отклонение записано в журнале спеки и в D-143.
- **`RemoteRegistry` — сервис DI** (`providedIn: 'root'`). `loadChildren` в Angular 22 вызывается в injection context, поэтому `loadRoutes` берёт сервис через `inject` до первого `await`. Манифест читается лениво при первом `loadRoutes`; при ошибке чтения или разбора кэш сбрасывается, следующая навигация пробует снова.
- **`main.ts` и `bootstrap.ts`** — два файла (D-145).
- **Сторы (T-24, 4.12).** Каркас не вызывает API: сессия и токен — `SESSION_USER` (`@swag/ui-angular`), сценарии входа, темы и выхода — `SHELL_STORE`. Оба — через мост `connectStore`. `@preact/signals-core` 1.14.5 — точная версия в `dependencies`, одна копия на страницу. Остаток `fetch` в каркасе — нет: манифест читает `readFederationManifest()` из `@swag/ui-angular`.

## Ограничения

- Маршруты `/signup`, `/signup/confirm`, `/invite` и их страницы добавит T-14 (D-144).
- Смена токена без перехода (renew после 401 в API) не перечитывает `AuthMe` до следующей навигации (D-146).
- Стили `tokens.css` и `base.css` подключаются через `angular.json` (`styles`), remote работают в документе каркаса.
- Dev-серверы только для разработки, продакшен-сборка и деплой — вне 014.

## Связи

- `@swag/ui-angular` — `SESSION_USER`, `SHELL_STORE`, `connectStore`, `provideShellStore`, `readFederationManifest`, `sessionGuard`, `areaGuard`, компоненты.
- `@swag/ui-core` — `navigationFor`, `authErrorText`, `safeReturnTo`, `isLocalRemoteUrl`.
- `apps/ui/cabinet` — remote `cabinet` (T-12). `apps/ui/admin`, `apps/ui/supervisor` — T-15, T-16.

## Спеки

- 014 — разделы 4.4, 4.5, 4.9 и 4.11 (задача T-11); 4.12 и REQ-014-23 (каркас на сторах, задача T-24).
