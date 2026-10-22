# @swag/ui-core

Ядро фронтендов платформы: валидация формы роя, открытие страницы роя с состоянием из событий, переподключение потока. Чистый TypeScript, без Angular и DOM: фронтенд передаёт реализации портов.

## Задачи

- `validateForm(input)` — проверка формы схемой `SwarmCreateRequest` с путями полей.
- `createSwarm(input)` — валидация, затем `SwarmsApi.create`.
- `listSwarms()` — список роёв.
- `openSwarm(id)` — страница роя: `view` строится через `applyEvent` из `@swag/api-integration`, `feed` — список принятых событий; при обрыве потока переподключение с `after = lastSeq` через паузу (1 с по умолчанию); повторные события не попадают в ленту.
- `SwarmPage.stop()` — остановка через `SwarmsApi.stop`; `close()` — закрыть поток и отменить переподключение.

## Что внутри сейчас

- `src/index.ts` — `createUiCore`, порты `SwarmsApi`, `EventStream`, `Timers`.
- `test/ui-core.test.ts` — AC-001-23.

## Ключевые решения

- Порты, а не `fetch`/`WebSocket` в ядре: адаптеры живут в `apps/ui/cabinet/src/app/api.ts` (T-12, T-13).
- Переподключение: `onError` от потока → `Timers.setTimeout` → `open(id, lastSeq)`; защита от повторов — проверкой `seq` по `applyEvent` и `feed`.
- Зависимости — `zod` (через `@swag/contracts`), `@swag/contracts`, `@swag/api-integration`: белый список ядра (REQ-001-18).

## Ограничения

Правила ядра ([архитектура](../../docs/architecture.md), [спека 000, 4.2](../../docs/spec/000-foundation.md#42-правила-ядра-и-оболочки)): нет окружения, DOM и инфраструктуры; всё внешнее — через порты.

## Связи

- Фронтенд: `apps/ui/cabinet` (`@swag/cabinet`).
- Использует: `@swag/contracts`, `@swag/api-integration`.

## Спеки

- 001 — 4.8, REQ-001-13.
- 014 — деление `ui-core` по фронтендам (D-11).
