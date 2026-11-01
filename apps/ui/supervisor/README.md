# @swag/supervisor

Организации платформы (Angular) — микрофронтенд (Native Federation remote) каркаса `apps/ui/shell` (спека 014, 4.4, REQ-014-13, T-16). Отдельно не открывается: каркас загружает экспорт `./routes`, даёт вход, шапку, сессию и выход.

## Запуск и сборка

- `npm run start` — `ng serve --configuration container`: host `0.0.0.0`, порт `4203`, `servePath` `/mf/supervisor/` (спека 014, 4.9). Так работает образ `Dockerfile`.
- Запуск на хосте — `npm run ui:dev` в корне: порт из `UI_<ИМЯ>_PORT` в `.env`, каркас проксирует `/mf/<имя>` на него (спека 014, 4.9, D-143).
- `npx ng build` — `dist/supervisor/browser/remoteEntry.json` и `routes-*.js` (экспорт `./routes`).
- Адрес remote в каркасе — `apps/ui/shell/public/federation.manifest.json`: `"supervisor": "/mf/supervisor/remoteEntry.json"`.

Host и порт задаются в конфигурации `serve-original` (`container`), а не флагами: builder федерации флаги `--host` не принимает (журнал T-11, D-143).

## Задачи

- `/supervisor` — страница «Организации» (REQ-014-13): таблица организаций из `GET /auth/organizations` — название (ссылка на организацию), число пользователей, дата создания (московское время). Пустой список показывается только после загрузки; ошибка — `swag-alert`.
- `/supervisor/organizations/:orgId` — страница организации:
  - название из того же списка; нет такой организации в списке — только текст `not_found` (4.6), остального нет;
  - таблица пользователей `GET /auth/users?orgId=` — общий `swag-user-table` (как у админки): действия строки — `userActions`, «Заблокировать» через подтверждение;
  - панель баланса `swag-balance-panel` этой организации: баланс, история с «Ещё», пополнение с обязательным комментарием.

## Что внутри сейчас

- `src/app/app.routes.ts` — экспорт `./routes`: обёртка `{ path: '', providers: [provideSupervisorStore()] }` с маршрутами `''` (список) и `organizations/:orgId`. Без `**` и без guard'ов: `areaGuard('supervisor')` стоит в каркасе.
- `src/app/organizations.page.ts` — страница списка. В конструкторе вызывает `SUPERVISOR_STORE.loadOrganizations()`. Логики в компоненте нет.
- `src/app/organization.page.ts` — страница организации. Конструктор вызывает `loadOrganizations()`; входной параметр `orgId` — сеттер, который вызывает `openOrganization(id)`. Логики в компоненте нет.
- `src/main.ts` — пустой модуль: remote не запускается отдельно.
- `federation.config.mjs` — `name: supervisor`, `exposes: { './routes' }`, `shareAll` с `singleton` и `strictVersion`, `@swag/*` через `sharedMappings`; конфиг как у админки.
- `proxy.conf.json` — как у админки: нужен только при прямом открытии порта 4203, через каркас запросы идут через его прокси.
- `Dockerfile` — dev-образ remote (`npm run start`, порт 4203). Сервис `ui-supervisor` в compose собирается из него, порт наружу не публикуется, healthcheck — `remoteEntry.json` на `127.0.0.1:4203`.

## Ключевые решения

- Remote, а не отдельное приложение: вход, шапка и сессия — каркас (REQ-014-2, REQ-014-11). Конфиг федерации и `shareAll` — как у админки.
- Порт 4203, `serve-path` `/mf/supervisor/` (4.9). `prebundle.exclude` в `angular.json` — `@swag/api-integration`, `@swag/contracts`, `@swag/ui-angular`, `@swag/ui-core` — как у админки (журнал T-25).
- Стор `SUPERVISOR_STORE` собирается в `./routes` через `provideSupervisorStore()` и живёт всю сессию вкладки; уничтожаются только компоненты (решение человека 2026-11-01, одинаково для всех разделов).
- `orgId` приходит входом маршрута (`withComponentInputBinding()` каркаса). Сеттер `@Input() set orgId` вызывает `openOrganization(id)`: загрузка идёт при заходе и при смене id без подписок и `effect`.
- Актуальность данных — перезагрузка на каждом заходе: список организаций перечитывается в конструкторе каждой страницы, пользователи и баланс — в `openOrganization`.
- Пополнение всегда с комментарием: страница вызывает `store.topup(input)`, а стор передаёт `requireComment = true` в `balance.topup` (4.12). Поэтому в панели баланса поле комментария обязательно.
- Цвета — только токены `var(--swag-…)`; литералов цвета нет (AC-014-10, тест в `scripts/ui-config.test.ts` проверяет все `apps/ui/*/src`).

## Ограничения

- Тестов Angular-части нет (нет TestBed-раннера): страницы проверяются сборкой `ng build` и ручной проверкой в `npm run up`. Логика — в `SupervisorStore` (`packages/ui-core/test/supervisor.store.test.ts`, AC-014-25).
- Доступ к разделу — `areaGuard('supervisor')` в каркасе; права на действия и пополнение проверяет API.

## Связи

- Логика: `SupervisorStore` из `@swag/ui-core`; мост и провайдер `SUPERVISOR_STORE` / `provideSupervisorStore()` — `@swag/ui-angular`; `swag-user-table`, `swag-balance-panel`, `swag-*` — там же.
- Каркас: `apps/ui/shell` (вход, шапка, манифест, прокси `/mf/supervisor`).
- Бэкенд: `GET /auth/organizations`, `GET /auth/users?orgId=`, `PATCH /auth/users/:id`, баланс через `/api` (013) через прокси каркаса.

## Спеки

- 014 — 4.4, 4.6, 4.7, 4.8, 4.9, 4.12, REQ-014-2, REQ-014-11, REQ-014-13, AC-014-8, AC-014-25 (T-16).
