# @swag/ui-core

Ядро фронтендов платформы: валидация формы роя, открытие страницы роя с состоянием из событий, переподключение потока. Чистый TypeScript, без Angular и DOM: фронтенд передаёт реализации портов.

## Задачи

- `validateForm(input)` — проверка формы схемой `SwarmCreateRequest` с путями полей.
- `createSwarm(input)` — валидация, затем `SwarmsApi.create`.
- `listSwarms()` — список роёв.
- `openSwarm(id)` — страница роя: `view` строится через `applyEvent` из `@swag/api-integration`, `feed` — список принятых событий; при обрыве потока переподключение с `after = lastSeq` через паузу (1 с по умолчанию); повторные события не попадают в ленту.
- `SwarmPage.stop()` — остановка через `SwarmsApi.stop`; `close()` — закрыть поток и отменить переподключение.
- `traceUrl(traceId)` — адрес трейса события в Grafana по шаблону из зависимостей; без `traceId` — `null` (спека 016, 4.10).
- `formatLlmCall(data)` — строка события `llm.call` для ленты роя: модель, токены с кэшем, стоимость в долларах (6 знаков), статус `прерван` или `ошибка <код>` (спека 002, 4.11). Чистая функция вне `createUiCore`: фронтенд вызывает её напрямую.

## Что внутри сейчас

- `src/index.ts` — `createUiCore`, порты `SwarmsApi`, `EventStream`, `Timers`, зависимость `traces: { urlTemplate }`, функция `formatLlmCall`.
- `test/ui-core.test.ts` — AC-001-23, AC-016-14.
- `test/format-llm-call.test.ts` — AC-002-24.

## Ключевые решения

- Порты, а не `fetch`/`WebSocket` в ядре: адаптеры живут в `apps/ui/cabinet/src/app/api.ts` (T-12, T-13).
- Переподключение: `onError` от потока → `Timers.setTimeout` → `open(id, lastSeq)`; защита от повторов — проверкой `seq` по `applyEvent` и `feed`.
- Зависимости — `zod` (через `@swag/contracts`), `@swag/contracts`, `@swag/api-integration`: белый список ядра (REQ-001-18).
- `traceUrl`: шаблон с подстановкой `{traceId}` приходит от фронтенда (`traces.urlTemplate`, обязательная зависимость), ядро не знает адреса Grafana. `traceId` подставляется через `encodeURIComponent` (для hex — без изменений), заменяются все вхождения `{traceId}`.

## Ограничения

Правила ядра ([архитектура](../../docs/architecture.md), [спека 000, 4.2](../../docs/spec/000-foundation.md#42-правила-ядра-и-оболочки)): нет окружения, DOM и инфраструктуры; всё внешнее — через порты.

## Связи

- Фронтенд: `apps/ui/cabinet` (`@swag/cabinet`).
- Использует: `@swag/contracts`, `@swag/api-integration`.

## Спеки

- 001 — 4.8, REQ-001-13.
- 016 — 4.10, REQ-016-13, AC-016-14.
- 014 — деление `ui-core` по фронтендам (D-11).
- 002 — 4.11, REQ-002-15, AC-002-24.
