# @swag/shell

Каркас фронтендов платформы: вход, регистрация, приглашение, шапка с навигацией и подгрузка микрофронтендов по правам. Спека 014, раздел 4.4 и 4.11.

## Что это и зачем

Каркас — Angular-приложение, которое хозяин сессии: восстанавливает её по cookie, показывает страницы входа и шапку, а разделы `cabinet`, `admin`, `supervisor` подгружает как Native Federation remote во время работы. Раздел без прав не загружается вовсе (REQ-014-3). Права в интерфейсе считает `@swag/ui-core` по `GET /auth/me`; доступ проверяет API.

## Что внутри сейчас (T-14, T-24)

- `src/main.ts` — `initFederation({})` без remote, затем `bootstrap.ts` (динамический импорт нужен, чтобы общие модули уже были в import map).
- `src/app/app.ts` — корень: тема (`SHELL_STORE.theme` → атрибут `data-theme` на `<html>`) применяется и на `/login`; выход — переход на `/login` при любом переходе `SESSION_USER.status` в «вышел» после первой навигации роутера (`redirectOnSignOut()` из `@swag/ui-angular`, та же логика в кабинете; до первой навигации уводит `sessionGuard`); на `NavigationEnd` — `SESSION_USER.ensureMe()` (смена токена); alert «Раздел недоступен» (4.6) — `SHELL_STORE.sectionUnavailable`: на `NavigationError` ставится, на `NavigationEnd` сбрасывается; alert здесь, вне Layout.
- `src/app/signup.page.ts` — `/signup`: email, после `form.sent` вместо формы — `REGISTRATION_SENT_TEXT`; ссылка «Уже есть аккаунт»; при открытой сессии — на `/`.
- `src/app/signup-confirm.page.ts` — `/signup/confirm?token=`: пароль, повтор, название организации; без токена — `authErrorText('invalid_token')` и ссылка «Зарегистрироваться заново»; открытая сессия — «Вы вошли как …» и «Выйти и продолжить».
- `src/app/invite.page.ts` — `/invite?token=`: пароль и повтор; без токена — `INVITATION_INVALID_TEXT`; открытая сессия — как на `/signup/confirm`.
- `src/app/auth-page.ts` — общее для страниц входа и регистрации: `takeToken` (токен из query один раз, `Location.replaceState` без query; пустой — как отсутствующий), `restoreSession` (`restore()` с `finally` — страница показывается и при отказе; переход после восстановления — только пока страница жива), `issueText` (текст ошибки поля), `inputValue`.
- `src/app/signed-in-notice.ts` — `app-signed-in-notice` (вход `email`): «Вы вошли как …» и «Выйти и продолжить» (`SHELL_STORE.logout`) на `/signup/confirm` и `/invite` при открытой сессии.
- `src/app/app.config.ts` — маршрутизатор (`withComponentInputBinding()`) и `provideShellStore()` (мост `ShellStore`, 014, 4.12).
- `src/app/app.routes.ts` — `/login` и раздел под `sessionGuard` с `LayoutComponent`; `admin` и `supervisor` — под `areaGuard`; `cabinet` — `''`; `**` → `''`.
- `src/app/remote-registry.ts` — сервис `RemoteRegistry`: чтение `/federation.manifest.json`, отбрасывание адресов вне `isLocalRemoteUrl` с `console.warn('remote_rejected', name)`, `loadRoutes(name)` — `loadRemoteModule` на `./routes`.
- `src/app/layout.ts` — шапка по REQ-014-10: пункты `SESSION_USER.navigation`, email и организация из `SESSION_USER.me`, тема (`SHELL_STORE.theme`, `setTheme`), «Выйти» (`SHELL_STORE.logout`); переход на `/login` после выхода делает корень по статусу.
- `src/app/login.page.ts` — `/login?returnTo=`: поля на `swag-field`; форма и вход — `SHELL_STORE.form()` и `SHELL_STORE.login(email, password, returnTo)`; результат не `null` — переход на него; при создании страницы форма сбрасывается (`resetForm()`, форма общая для страниц каркаса). Уже открытая сессия (`SESSION_USER.restore()`) сразу уводит на `returnTo`.
- `public/federation.manifest.json` — `cabinet`, `admin` и `supervisor`.
- `federation.config.mjs`, `tsconfig*.json`, `angular.json` — конфиг из журнала T-1 (`spike-shell`, переименован в `shell`), с двумя уточнениями, см. ниже.
- `proxy.conf.json` — `/api`, `/auth`, `/grafana` на контейнеры compose, `/mf/cabinet` на `ui-cabinet:4201`, `/mf/admin` на `ui-admin:4202` и `/mf/supervisor` на `ui-supervisor:4203` (4.9): записи прокси уже есть. Сервис `ui-supervisor` есть в compose (T-16), пункт «Организации» открывает remote.

## Как запускать

- `npm run start` в `apps/ui/shell` — `ng serve --configuration container`: host `0.0.0.0`, порт `4200`. Так работает образ `Dockerfile`.
- `npm run ui:dev` в корне — четыре dev-сервера на хосте (каркас и три remote) на портах из `.env`; скрипт `scripts/ui-dev.ts`, спека 014, 4.9. Каркас идёт в конфигурации `host` (`proxy.host.conf.mjs`), без `npm run start`. Нужно `docker compose stop ui`, иначе `UI_PORT` занят.
- `npx ng build` — сборка каркаса с `remoteEntry.json` и манифестом в `dist/shell/browser`.

Compose поднимает `ui` (этот каркас, порт `UI_PORT`), `ui-cabinet`, `ui-admin` и `ui-supervisor` (remote, порты не публикуются). `ui` ждёт их (`service_healthy`), поэтому после `npm run up` вход и разделы кабинета доступны в браузере через `http://127.0.0.1:4200`.

- **Запуск на хосте (D-143, T-19).** Builder федерации не принимает `--host`, поэтому хост задаётся конфигурацией `serve-original.host` (`127.0.0.1`, прокси `proxy.host.conf.mjs`), а `serve.host` ссылается на неё, как `container`. Порт приходит флагом `--port` из `ui-dev.ts`: проверено, что builder передаёт его в dev-сервер. Прокси `proxy.host.conf.mjs` берёт адреса из env на момент импорта и падает с именем переменной, если её нет. `/internal` не проксируется (тест AC-014-20).

## Ключевые решения

- **Native Federation** (Q-1, 014): `shareAll` с `singleton`, `strictVersion`, `requiredVersion: 'auto'`; `@swag/*` — через `sharedMappings` (исходники TS).
- **`skipList`:** `NG_SKIP_LIST`, `@angular/build|cli|compiler-cli`, `@swag/*` и `@angular/cdk/schematics` (D-141). Без последнего сборка падает: entry point `schematics` тянет `@angular-devkit/core`, которого не бандлит browser-shared.
- **`@angular/cdk` и `@angular/forms` в `package.json`** каркаса: без них `shareAll` не делит их между каркасом и remote, а `swag-confirm` использует `Dialog` из cdk (D-142).
- **`prebundle.exclude`** в `serve-original` (как у кабинета, T-25): `@swag/api-integration`, `@swag/contracts`, `@swag/ui-angular`, `@swag/ui-core` не пре-бандлятся, иначе декораторы `@swag/ui-angular` не компилировались и страница была пустой.
- **`ng serve --host` не работает** с builder'ом `serve` Native Federation (схема его не знает). Host и порт задаются в `serve-original`; `container` — конфигурация для контейнера. Отклонение записано в журнале спеки и в D-143.
- **`RemoteRegistry` — сервис DI** (`providedIn: 'root'`). `loadChildren` в Angular 22 вызывается в injection context, поэтому `loadRoutes` берёт сервис через `inject` до первого `await`. Манифест читается лениво при первом `loadRoutes`; при ошибке чтения или разбора кэш сбрасывается, следующая навигация пробует снова.
- **`main.ts` и `bootstrap.ts`** — два файла (D-145).
- **Сторы разделов живут сессию вкладки.** Провайдеры в `./routes` remote (например `provideCabinetStore()`) создают стор при первом заходе в раздел и держат его до закрытия вкладки. При уходе уничтожаются компоненты, инжекторы маршрутов не уничтожаются. Актуальность данных даёт сам стор: при заходе на экран он перезагружает данные (решение человека 2026-11-01, спека 014, журнал T-13).
- **Сторы (T-24, 4.12).** Каркас не вызывает API: сессия и токен — `SESSION_USER` (`@swag/ui-angular`), сценарии входа, темы и выхода — `SHELL_STORE`. Оба — через мост `connectStore`. `@preact/signals-core` 1.14.5 — точная версия в `dependencies`, одна копия на страницу. Остаток `fetch` в каркасе — нет: манифест читает `readFederationManifest()` из `@swag/ui-angular`.

## Ограничения

- Стили `tokens.css` и `base.css` подключаются через `angular.json` (`styles`), remote работают в документе каркаса.
- Dev-серверы только для разработки, продакшен-сборка и деплой — вне 014.

## Связи

- `@swag/ui-angular` — `SESSION_USER`, `SHELL_STORE`, `connectStore`, `provideShellStore`, `readFederationManifest`, `sessionGuard`, `areaGuard`, компоненты.
- `@swag/ui-core` — `navigationFor`, `authErrorText`, `safeReturnTo`, `isLocalRemoteUrl`.
- `apps/ui/cabinet` — remote `cabinet` (T-12). `apps/ui/admin` — remote `admin` (T-15). `apps/ui/supervisor` — remote `supervisor` (T-16).

## Спеки

- 014 — разделы 4.4, 4.5, 4.9 и 4.11 (задача T-11); страницы регистрации и приглашения, REQ-014-6…9 (задача T-14); 4.12 и REQ-014-23 (каркас на сторах, задача T-24).
