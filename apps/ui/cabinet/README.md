# @swag/cabinet

Личный кабинет (Angular) — микрофронтенд (Native Federation remote) каркаса `apps/ui/shell` (спека 014, 4.4, T-12). Отдельно не открывается: каркас загружает экспорт `./routes`, даёт вход, шапку, тему и выход.

## Запуск и сборка

- `npm run start` — `ng serve --configuration container`: host `0.0.0.0`, порт `4201`, `servePath` `/mf/cabinet/` (спека 014, 4.9). Так работает образ `Dockerfile`.
- Запуск на хосте — `npm run ui:dev` в корне: порт из `UI_<ИМЯ>_PORT` в `.env`, каркас проксирует `/mf/<имя>` на него (спека 014, 4.9, D-143).
- `npx ng build` — `dist/cabinet/browser/remoteEntry.json` и `routes-*.js` (экспорт `./routes`).
- Адрес remote в каркасе — `apps/ui/shell/public/federation.manifest.json`: `"cabinet": "/mf/cabinet/remoteEntry.json"`.

В `ng serve` host и порт задаются в конфигурации `serve-original` (`container`), а не флагами: builder `serve` Native Federation флаги `--host` не принимает (журнал T-11, D-143).

## Задачи

- `/` — список роёв: задача, статус, число агентов, время; кнопка «Новый рой».
- `/swarms/new` — форма: задача, «Бюджет, $» роя (по умолчанию `0.50`, шаг `0.01`) и агенты (имя, роль, модель из `PlatformModel`, по умолчанию `chat-small`, «Бюджет агента, $» — необязательный, пустое поле — бюджета нет; «Лимит ответа, токенов» у роя и у агента — необязательный, пустое поле — значение по умолчанию, спека 031, 4.6). Первый агент — вход: получает задачу и завершает рой через `finish` (спека 022). Поля бюджета переводятся в micro-USD функцией `swarmFormInput` из `@swag/ui-core` (спека 004, 4.8), поля лимита ответа — в `maxTokens` той же функцией (спека 031, 4.5). Ответ `402 insufficient_balance` (спека 013, 4.11) выводится текстом «Недостаточно средств: доступно $X»: `X` — `formatUsd(availableMicroUsd)` из `GET /organizations/:orgId/balance`, перечитанного после отказа; если перечитать не удалось — текст ошибки сервера.
- `/balance` — страница «Баланс» организации (спека 013, 4.11): три числа «Баланс», «В резерве», «Доступно» (`formatUsd`), история «Дата / Вид / Сумма / Рой / Комментарий» от новых к старым, кнопка «Ещё» по `nextBefore` (скрыта, когда страниц больше нет). Форма «Пополнение» — только при праве `balance.topup` у роли (`ROLE_PERMISSIONS`): сумма в долларах переводится `usdToMicro`, тело проверяется схемой `TopupRequest` из `@swag/contracts`, пустой комментарий уходит как `null`; после успеха баланс и история перечитываются с первой страницы; ошибка ответа — текстом под формой. Пункт «Баланс» в шапке — только у сессии с организацией; супервизору страница говорит, что баланс доступен пользователям организации.
- `/swarms/:id` — строка денег над графом (потрачено из бюджета, остаток, расход за последнюю минуту — `CabinetStore.money`; обновляется по каждому событию и раз в 5 с), граф (агенты по кругу, цвет по статусу, модель и число шагов в узле, на рёбрах стрелка и число сообщений), список агентов с суммой «потрачено» и бюджетом, если он задан (`formatUsd`), лента событий, результат или причина ошибки (`budget_exceeded` — «бюджет исчерпан», `gateway_unavailable` — «шлюз моделей недоступен», `detail` рядом), «Стоп» для активного роя. Обновление — из WebSocket. У события с `traceId` в ленте — ссылка «Трейс» в новой вкладке (спека 016). Событие `llm.call` выводится строкой вызова модели через `formatLlmCall` из `@swag/ui-core` (спека 002, 4.11), `agent.step` — строкой шага через `formatAgentStep` (спека 022, 4.10). `agent.idle` в ленте без особого формата — пустое описание, как у прочих событий без строки. `bus.message`, которое получатель не начал обрабатывать, помечается «не прочитано» (спека 030, REQ-030-6): вычисляет `CabinetStore.unread` (`unreadMessageIds` из `@swag/ui-core`) по ленте и статусу роя, страница только выводит отметку классом `unread`.

## Что внутри сейчас

- Из `@swag/ui-angular` (спека 014, 4.12, T-24): токен `SESSION_USER` (сессия, роль и `orgId` из `GET /auth/me`, вход, выход, `accessToken` и `renew` для адаптеров), `CABINET_STORE` и `provideCabinetStore()` (в `./routes`, T-12), `connectStore`, `toAngularSignal`, `createBalanceApi` (баланс, 013, 4.11), `HttpError` (ошибка ответа с полями `status` и `code`; ветка `402` в форме роя). Подробности — `packages/ui-angular/README.md`.
- `src/app/balance.page.ts` — страница `/balance` (спека 013, 4.11; 014, 4.12): обёртка `swag-page` + `swag-balance-panel` с `[state]="cabinet.balance"`; `open(orgId)` в конструкторе при каждом заходе, `orgId` — из `connectStore(SESSION_USER).orgId()` (`null` сбрасывает состояние), без `effect` на странице; `more` и `topup` вызывают `CABINET_STORE.balance`, `requireComment` = false. Состояния на странице нет.
- Маршруты — экспорт `./routes` (`src/app/app.routes.ts`, 014, 4.4): префикс `''`, без `**`. `areaGuard('swarms')` на `''`, `swarms/new`, `swarms/:id`; `areaGuard('balance')` на `balance` (`canMatch`, до загрузки кода). `provideCabinetStore()` — в `providers` родительского маршрута, не в корне приложения (T-25). Стор создаётся при первом заходе в раздел и живёт до закрытия вкладки; при уходе уничтожаются компоненты, а не стор. При заходе на экран данные перезагружаются: `loadSwarms` сбрасывает список, страница роя — `openSwarm` (поток закрывается при уходе со страницы через `closeSwarm`), форма — `resetForm`, страница баланса — `balance.open(orgId)`, который сбрасывает и перезагружает состояние баланса. Сессию проверяет `sessionGuard` каркаса на родителе раздела.
- `src/main.ts` — пустой модуль: remote не запускается отдельно, точки входа приложения нет.
- `federation.config.mjs` — конфиг Native Federation из журнала T-1 (`name: cabinet`, `exposes: { './routes' }`), `shareAll` с `singleton` и `strictVersion`, `@swag/*` через `sharedMappings`.
- Входа, шапки, `app.config.ts` и `app.ts` у кабинета нет (014, REQ-014-11): страницу входа `/login`, выход и пункт «Баланс» в шапке даёт каркас.
- Файла `ui.ts` нет (T-25): адаптеры роёв и баланса, `TRACE_URL_TEMPLATE` (ссылка на трейс в Grafana Explore) собирает `provideCabinetStore()` из `@swag/ui-angular`, токенов `UI` и `BALANCE` в кабинете нет.
- `src/app/swarm-graph.ts` — граф роя, чистый SVG без библиотеки (Q-4). Геометрия — чистые функции `layoutNodes` (узлы по кругу) и `edgePath` (путь ребра, дуга, петля). Цвета — `var(--swag-…)`, заливка статусов — `color-mix` от токенов (D-134).
- `src/index.html` — без `<style>`. Стили `tokens.css` и `base.css` не подключаются: их даёт каркас (`angular.json` кабинета без `styles`).
- Страницы роёв — `swarm-list.page.ts`, `swarm-new.page.ts`, `swarm.page.ts` (T-25): читают `CABINET_STORE` (сигналы и `form()`) и вызывают его команды (`loadSwarms`, `createSwarm`, `resetForm`, `openSwarm`, `closeSwarm`, `stopSwarm`, `traceUrl`). `swarm-list.page.ts` вызывает `loadSwarms` при каждом заходе: до ответа список пуст. `swarm-new.page.ts` вызывает `resetForm()` при создании страницы: поля пустые, ошибки прошлого захода не показываются. Ввод формы — локальные сигналы страницы; навигация на страницу роя — по `id`, который вернул `createSwarm`. Страницы строятся на базовых компонентах 4.8 (`swag-page`, `swag-table`, `swag-field`, `swag-alert`, `button[swag-button]`, REQ-014-17): ошибка поля — из `cabinet.form().issues` по `path`, ошибки без поля — общим `swag-alert`. «Новый рой» — ссылка классом `button` на токенах (у `swag-button` нет варианта для `a`). `swarm.page.ts`: `id` роя приходит входом маршрута через сеттер `@Input() set id`, который вызывает `openSwarm` при каждом заходе; `closeSwarm()` — на `DestroyRef`. Ссылка «Трейс» — только `cabinet.traceUrl`. Таймеров, подписок, `effect` и проверок формы на страницах нет.
- `proxy.conf.json` — `/api` → `api:3000` (снимает префикс; WebSocket включён); `/auth` → `identity:3003` без снятия префикса; `/grafana` → `lgtm:3000` без снятия префикса (Grafana на подпути). `/internal` не проксируется.
- `Dockerfile` — dev-образ remote (`npm run start`, порт 4201). Сервис `ui-cabinet` в compose собирается из него (спека 014, 4.9): порт наружу не публикуется, healthcheck — `remoteEntry.json` на `127.0.0.1:4201`.

## Ограничения

- Только `ng serve` (Q-4). Скрипт `build` (`ng build`) в `package.json` есть, но в CI и в Docker-образе не используется; раздачи собранного приложения в 001 нет. Remote отдаётся каркасом через прокси `/mf/cabinet`.
- Компоненты не содержат правил: валидация, перевод денег, тексты причин, состояние роя и переподключение — в `@swag/ui-core`. Компонент передаёт значения полей и выводит готовые строки.
- Пользовательский текст выводится только интерполяцией Angular, без `innerHTML`.
- Тестов в cabinet нет: Angular-тестового раннера в проекте нет. Компоненты проверяются сборкой `ng build` и ручной проверкой UI (T-20). Логика денег и её тесты — в `@swag/ui-core` (`packages/ui-core/test/money-input.test.ts`).
- Превышение бюджета агента над бюджетом роя форма не проверяет: `SwarmCreateRequest` этого не требует, сервер отвечает `400`, текст выводится в ошибке формы (спека 004, 4.7, D-105).

## Связи

- Логика: `@swag/ui-core`; сессия, HTTP и адаптеры общих портов: `@swag/ui-angular`; типы и проекция: `@swag/contracts`, `@swag/api-integration`.
- Бэкенд: `apps/api` через прокси.

## Ключевые решения

- Angular 22.2.3 (`@angular/*`, `@angular/build`, `@angular/cli`), состояние — signals. Версии точные (`save-exact`). Zoneless — по умолчанию с Angular 21 (angular.dev/guide/zoneless). Приложением — bootstrap, zoneless и роутер — владеет каркас `apps/ui/shell`; кабинет отдаёт только `./routes`, `app.config.ts` у него нет.
- `proxy.conf.json` подключён через `angular.json` → `serve-original.options.proxyConfig`. `ws: true` передаётся в прокси Vite, `pathRewrite` `@angular/build` переводит в `rewrite` (`utils/load-proxy-config.js`). angular.dev (https://angular.dev/tools/cli/serve) описывает только `target` и `secure`; поведение `ws`/`pathRewrite` — по исходникам установленного `@angular/build` 22.2.3. `provideBrowserGlobalErrorListeners` есть в типах `@angular/core`.
- Цвета кабинета — только токены `--swag-*` (REQ-014-16): литералы `#rrggbb`, `rgb(`, `hsl(` в `src` запрещены тестом AC-014-10 (`scripts/ui-config.test.ts`).
- Граф — собственный SVG-компонент без библиотеки (Q-4). Узлы по кругу в порядке id, радиус не меньше 120 px и не меньше, чем нужно для зазора `NODE_GAP` между соседними узлами. Встречные рёбра `a → b` и `b → a` рисуются квадратичными кривыми внутрь круга на разную глубину (15 и 60 px), подписи пары — ближе к началу своей дуги, поэтому не накладываются. Наружу дуга не выгибается: при 5 и более агентах она заходила бы под соседний узел (ревью T-15); параметры проверены расчётом для 2–8 агентов; одиночное ребро — прямая. Петля (ребро на себя, по 4.10) — дуга наружу от круга. Подписи с белой обводкой, чтобы читались на линии.
- Шаги агента (`agent.step`) — строкой ленты через `formatAgentStep`, без отдельного экрана.
- Деньги (спека 004, 4.8): перевод полей формы — `swarmFormInput` из `ui-core` (доллары → micro-USD, пустой бюджет агента — `null`); некорректный ввод даёт `NaN`, который отсекает `SwarmCreateRequest`. Суммы на экране — через `formatUsd`; строку роя считает `CabinetStore.money` (`formatSwarmMoney`).
- Строка денег обновляется таймером раз в 5 с (`MONEY_TICK_MS` в `packages/ui-core/src/cabinet.store.ts`) и по каждому событию. Тик ведёт `CabinetStore` через `Timers` (D-149): запускается в `openSwarm`, снимается в `closeSwarm`, который страница вызывает на `DestroyRef`.
- Тексты причин `budget_exceeded` и `gateway_unavailable` — `failureReasonText` из `ui-core` (4.8), прочие причины выводятся как пришли (D-107).
- Логика вне компонентов: `CabinetStore` из `@swag/ui-core` подключается через `CABINET_STORE` (`provideCabinetStore()`, `connectStore`); `createUiCore` собран внутри стора.
- Сессия (024, 4.15; 014, 4.12): один стор `SessionUserStore` (`SESSION_USER`, `providedIn: root`) на страницу, внутри `createAuthSessionKeeper`. Один `renew()` на все одновременные `401` — общий промис в `createRequest` и в `ui-core`. Неудача обновления — выход, переход на `/login`. Трактовка: при закрытии потока `4401` вызывается `renew()`; только при `true` поток сообщает `onError`, и `ui-core` переподключается через 1 с с новым токеном; при `false` переподключения нет, выход уводит на `/login`. Без токена поток не открывается и не сообщает `onError`: сессии нет, переход на `/login` уводит guard, бесконечного переподключения нет.
- Роль и организация (013, 4.11, решение D-130 от 2026-11-01; 014, 4.12): `SESSION_USER` берёт их из `GET /auth/me` (схема `AuthMe` из `@swag/contracts`: `user.role`, `organization.id`), а не из claims токена. Перечитывание — `restore()` в `sessionGuard`, `ensureMe()` в `areaGuard` и на `NavigationEnd`; смена токена, которую не заметил вызов, подхватывается на следующей навигации. Выход и `onSignedOut` сбрасывают результат. Ошибка `/auth/me` или ответ не по схеме — пользователь неизвестен: пункта «Баланс» и формы нет, приложение не падает. Пункт «Баланс», `orgId` страницы и форма пополнения (`ROLE_PERMISSIONS[role]` содержит `balance.topup`) — из этого результата. Это только для показа; права проверяет API. Переход на несколько организаций — отдельная спека (D-131).
- Вход не проверяет `Authorization` сам: guard смотрит только наличие токена в памяти; истёкший токен обновляется на первом `401` от `api`.
- Dev-сервер remote — Native Federation (`serve` → `serve-original`). Прокси `/api`, `/auth`, `/grafana` в `proxy.conf.json` нужны только при прямом открытии порта 4201; через каркас запросы идут через его прокси. Отклонение: в CI сборка `ng build` не запускается (спека требует `npm run check` без UI-шага).
- `allowImportingTsExtensions` и `rewriteRelativeImportExtensions` в tsconfig — чтобы Angular собирал TS-исходники `packages/*` с расширениями `.ts`.
- Ссылка «Трейс» (016, Q-6): относительный адрес `/grafana/explore?...` через прокси `ng serve`, без конфигурации в UI. Шаблон — Explore Grafana с источником Tempo (uid `tempo` в `grafana/otel-lgtm`), запрос TraceQL — сам `traceId`, диапазон — последние 7 дней. Адрес строит `ui-core.traceUrl`, компонент только рисует `<a target="_blank" rel="noopener">`. SDK OpenTelemetry в браузере нет (Q-7).

## Спеки

- 001 — 4.8, T-13.
- 004 — 4.8, T-15 (REQ-004-17: бюджет в форме, строка денег и суммы агентов, таймер 5 с, тексты причин; логика — в `ui-core`).
- 016 — 4.10, Q-6, Q-7.
- 022 — 4.10, T-15 (форма с моделью, строка шага, граф по кругу; ручная проверка AC-022-25 — в T-17).
- 002 — 4.11, REQ-002-15 (строка `llm.call` в ленте, T-30).
- 030 — 4.4, REQ-030-6, T-5 (отметка «не прочитано» в ленте).
- 014 — каркас и микрофронтенд; T-6: сессия, HTTP и адаптеры баланса перенесены в `@swag/ui-angular` (4.7); T-8: стили `index.html` и цвета графа переведены на токены `@swag/ui-angular` (REQ-014-16, AC-014-10).
- 014 — 4.4, 4.5, 4.9, REQ-014-2, REQ-014-11 (T-12): remote, экспорт `./routes`, без входа и шапки, `serve-path /mf/cabinet/`.
- 014 — 4.12, REQ-014-23 (T-24, T-25): кабинет на `SESSION_USER` и `CABINET_STORE`; страницы роёв и баланса читают стор, `ui.ts` удалён; проверка импортов AC-014-26 — `scripts/ui-config.test.ts`.
- 024 — 4.6, 4.15, REQ-024-13, T-16 (вход, сессия, прокси `/auth`; ручная проверка AC-024-26 — в T-17).
- 013 — 4.11, REQ-013-11, T-15 (страница «Баланс», пункт в шапке, маршрут `/balance`), T-16 (форма пополнения, отказ `402` в форме роя; ручная проверка AC-013-25 — в T-18).
