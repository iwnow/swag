# @swag/admin

Администрирование организации (Angular) — микрофронтенд (Native Federation remote) каркаса `apps/ui/shell` (спека 014, 4.4, REQ-014-12, T-15). Отдельно не открывается: каркас загружает экспорт `./routes`, даёт вход, шапку, сессию и выход.

## Запуск и сборка

- `npm run start` — `ng serve --configuration container`: host `0.0.0.0`, порт `4202`, `servePath` `/mf/admin/` (спека 014, 4.9). Так работает образ `Dockerfile`.
- Запуск на хосте — `npm run ui:dev` в корне: порт из `UI_<ИМЯ>_PORT` в `.env`, каркас проксирует `/mf/<имя>` на него (спека 014, 4.9, D-143).
- `npx ng build` — `dist/admin/browser/remoteEntry.json` и `routes-*.js` (экспорт `./routes`).
- Адрес remote в каркасе — `apps/ui/shell/public/federation.manifest.json`: `"admin": "/mf/admin/remoteEntry.json"`.

Host и порт задаются в конфигурации `serve-original` (`container`), а не флагами: builder федерации флаги `--host` не принимает (журнал T-11, D-143).

## Задачи

- `/admin/users` (маршрут `users` под префиксом `admin`; `''` → `users`) — страница «Пользователи» (REQ-014-12):
  - таблица пользователей организации: email, роль, «заблокирован» (да/нет), дата создания (московское время, как в панели баланса); действия строки — ровно `userActions` (подписи `USER_ACTION_LABEL` из `@swag/ui-core`);
  - «Заблокировать» открывает `swag-confirm` с текстом `blockConfirmText(email)`; остальные действия выполняются сразу;
  - форма «Пригласить пользователя»: email (ошибка поля из `invite().issues`), роль «Пользователь» или «Администратор», после успеха — текст «Приглашение отправлено на …» из стора; ошибки — `swag-alert`.

## Что внутри сейчас

- `src/app/app.routes.ts` — экспорт `./routes`: обёртка `{ path: '', providers: [provideAdminStore()] }` с маршрутами `users` и `''` → `users`. Без `**` и без guard'ов: `areaGuard('admin')` стоит в каркасе.
- `src/app/users.page.ts` — страница. В конструкторе вызывает `ADMIN_STORE.load()` и `resetInvite()`. Состояния, правил и текстов ошибок в компоненте нет: только шаблон над сигналами стора и его методами. Таблица пользователей — общий `swag-user-table` из `@swag/ui-angular` (T-16, та же у супервизора), локального состояния страница не держит.
- `src/main.ts` — пустой модуль: remote не запускается отдельно.
- `federation.config.mjs` — `name: admin`, `exposes: { './routes' }`, `shareAll` с `singleton` и `strictVersion`, `@swag/*` через `sharedMappings`; конфиг как у кабинета.
- `proxy.conf.json` — как у кабинета: нужен только при прямом открытии порта 4202, через каркас запросы идут через его прокси.
- `Dockerfile` — dev-образ remote (`npm run start`, порт 4202). Сервис `ui-admin` в compose собирается из него, порт наружу не публикуется, healthcheck — `remoteEntry.json` на `127.0.0.1:4202`.

## Ключевые решения

- Remote, а не отдельное приложение: вход, шапка и сессия — каркас (REQ-014-2, REQ-014-11). `shareAll` и `sharedMappings` — как у кабинета, чтобы `@swag/*` и Angular были общими экземплярами.
- Порт 4202, `serve-path` `/mf/admin/` (4.9). `prebundle.exclude` для `@swag/*` в `angular.json` — иначе декораторы `@swag/ui-angular` не компилируются при `ng serve` (журнал T-25).
- Стор `ADMIN_STORE` собирается в `./routes` через `provideAdminStore()` и живёт всю сессию вкладки; уничтожаются только компоненты (решение человека 2026-11-01, одинаково для всех разделов).
- Актуальность данных — перезагрузка на каждом заходе на страницу: `load()` и `resetInvite()` в конструкторе страницы.
- Подтверждение нужно только для блокировки (4.6): диалог `swag-confirm` живёт внутри `swag-user-table`, текст — `blockConfirmText(email)` из `ui-core`; после подтверждения таблица отдаёт `action`, страница вызывает `apply(id, 'block')`; по отмене ничего не происходит.
- Таблица не мигает после «Заблокировать» и других действий: список перечитывается без сброса; `empty` показывается только после первого ответа (`loaded`).
- Приглашение: успех показывается `swag-alert` над формой, форма остаётся заполненной; следующая отправка сбрасывает сообщение. Форма не скрывается: сообщение и форма на странице одновременно, это соответствует комментарию стора.
- Дата в таблице — `formatDateTime` из `@swag/ui-core` (московское время, короткий формат), та же функция у `balance-panel`.
- Цвета — только токены `var(--swag-…)`; литералов цвета нет (AC-014-10, тест в `scripts/ui-config.test.ts` проверяет `apps/ui/admin/src`).

## Ограничения

- Тестов Angular-части нет (нет TestBed-раннера): страница проверяется сборкой `ng build` и ручной проверкой в `npm run up`. Логика — в `AdminStore` (`packages/ui-core/test/admin.store.test.ts`, AC-014-24).
- Доступ к разделу — `areaGuard('admin')` в каркасе; права на действия проверяет API.

## Связи

- Логика: `AdminStore` из `@swag/ui-core`; мост и провайдер `ADMIN_STORE` / `provideAdminStore()` — `@swag/ui-angular`; компоненты `swag-*`, в том числе `swag-user-table`, — там же.
- Каркас: `apps/ui/shell` (вход, шапка, манифест, прокси `/mf/admin`).
- Бэкенд: `GET /auth/users`, `POST /auth/invitations`, `PATCH /auth/users/:id` через прокси каркаса.

## Спеки

- 014 — 4.4, 4.5, 4.6, 4.8, 4.9, 4.12, REQ-014-2, REQ-014-3, REQ-014-11, REQ-014-12, AC-014-24 (T-15).
