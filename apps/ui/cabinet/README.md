# @swag/cabinet

Личный кабинет (Angular). В 001 — самостоятельное приложение с экранами роя; в 014 станет микрофронтендом каркаса.

## Задачи

- `/` — список роёв: задача, статус, число агентов, время; кнопка «Новый рой».
- `/swarms/new` — форма: задача и агенты (имя, роль), порядок сверху вниз = порядок цепочки.
- `/swarms/:id` — граф (агенты по статусу, на рёбрах число сообщений), лента событий, результат или причина ошибки, «Стоп» для активного роя. Обновление — из WebSocket. У события с `traceId` в ленте — ссылка «Трейс» в новой вкладке (спека 016). Событие `llm.call` выводится строкой вызова модели через `formatLlmCall` из `@swag/ui-core` (спека 002, 4.11).

## Что внутри сейчас

- `src/app/api.ts` — адаптеры портов `ui-core`: REST и WebSocket по относительному пути `/api`.
- `src/app/ui.ts` — `ui-core` в DI-токене `UI`; `TRACE_URL_TEMPLATE` — шаблон ссылки на трейс в Grafana Explore.
- `src/app/swarm-graph.ts` — граф роя, чистый SVG без библиотеки (Q-4).
- Страницы: `swarm-list.page.ts`, `swarm-new.page.ts`, `swarm.page.ts`.
- `proxy.conf.json` — `/api` → `api:3000` (снимает префикс; WebSocket включён); `/grafana` → `lgtm:3000` без снятия префикса (Grafana на подпути).
- `Dockerfile` — dev-образ для `npm run up` (`ng serve`).

## Ограничения

- Только `ng serve` (Q-4); продакшен-сборки и раздачи в 001 нет.
- Компоненты не содержат правил: валидация, состояние роя и переподключение — в `@swag/ui-core`.
- Пользовательский текст выводится только интерполяцией Angular, без `innerHTML`.
- Входа нет (до спеки 012).

## Связи

- Логика: `@swag/ui-core`; типы и проекция: `@swag/contracts`, `@swag/api-integration`.
- Бэкенд: `apps/api` через прокси.

## Ключевые решения

- Angular 22.2.3 (`@angular/*`, `@angular/build`, `@angular/cli`), zoneless (`provideZonelessChangeDetection`), состояние — signals. Версии точные (`save-exact`).
- Граф — собственный SVG-компонент без библиотеки (Q-4).
- Логика вне компонентов: `createUiCore` из `@swag/ui-core` подключается через токен `UI`.
- Dev-сервер и прокси `/api` → `api:3000` (Q-4). Отклонение: в CI сборка `ng build` не запускается (спека требует `npm run check` без UI-шага).
- `allowImportingTsExtensions` и `rewriteRelativeImportExtensions` в tsconfig — чтобы Angular собирал TS-исходники `packages/*` с расширениями `.ts`.
- Ссылка «Трейс» (016, Q-6): относительный адрес `/grafana/explore?...` через прокси `ng serve`, без конфигурации в UI. Шаблон — Explore Grafana с источником Tempo (uid `tempo` в `grafana/otel-lgtm`), запрос TraceQL — сам `traceId`, диапазон — последние 7 дней. Адрес строит `ui-core.traceUrl`, компонент только рисует `<a target="_blank" rel="noopener">`. SDK OpenTelemetry в браузере нет (Q-7).

## Спеки

- 001 — 4.8, T-13.
- 016 — 4.10, Q-6, Q-7.
- 002 — 4.11, REQ-002-15 (строка `llm.call` в ленте, T-30).
- 014 — каркас и микрофронтенд.
