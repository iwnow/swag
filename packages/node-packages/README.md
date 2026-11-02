# @swag/node-packages

Загрузчик манифестов пакетов узлов (спеки 021, 4.7 и 026, 4.4). Общий для `api` и оркестратора (REQ-026-14): оба читают один и тот же набор пакетов из `NODE_PACKAGES` и получают одинаковый реестр.

## Задачи

- `loadNodePackages(packages, options)` — прочитать `swag-node.json` каждого пакета, собрать реестр типов и карту `ref → пакет`; ошибка — `NodeTypesLoadError`.
- `packageOf(ref)` — имя пакета, из которого загружен тип `type@version`; неизвестный тип — `null`. Нужен оркестратору, чтобы знать, какой пакет импортировать в песочнице.
- `bootNodePackages(packages, deps)` — то же для запуска процесса: ошибка пишется логом `node_manifest_invalid` и передаётся в `fail()`.
- `loadNodeRegistry` и `bootNodeRegistry` — обёртки, возвращают только реестр.

## Что внутри сейчас

- `src/index.ts` — `NodeTypesLoadError`, `LoadNodeTypesOptions`, `NodePackages`, четыре функции загрузки. Перенесено из `apps/api/src/node-types.ts` без изменения поведения.
- `test/node-packages.test.ts` — AC-021-4, AC-021-17, AC-021-18 (перенесены с теми же id), AC-026-4 (`packageOf` в `loadNodePackages` и `bootNodePackages`).
- `test/fixtures/packages/*` — фикстуры загрузчика: `acme-nodes`, `broken-node`, `echo-copy`, `throwing-node`.

## Ключевые решения

- Загрузка по-прежнему читает только `swag-node.json` через `exports` пакета (`resolve` по умолчанию — `createRequire` от этого модуля); код пакета не импортируется (021, REQ-021-13).
- Карта `packageOf` строится из тех же манифестов, что и реестр, без повторного чтения файлов. Повтор `type@version` между пакетами по-прежнему ошибка, поэтому ссылка всегда однозначна.
- `loadNodeRegistry` и `bootNodeRegistry` не дублируют логику, а берут `.registry` у `loadNodePackages` и `bootNodePackages`.
- Значение по умолчанию `resolve` ищет пакеты узлов от расположения этого модуля, то есть через `node_modules` репозитория, а не от `apps/api`.

## Ограничения

- Не ядро: читает файлы, поэтому `node:*` разрешены. Правило ядер (`arch:check`) сюда не распространяется.
- Не импортирует код узлов и не проверяет его исполнение: это делает песочница.
- Проверка манифеста и схем — в `@swag/api-integration` (`createNodeRegistry`).

## Связи

- Используют: `apps/api` (`main.ts`, тесты каталога `node-types-http.test.ts`). Оркестратор пока не использует; подключит пакет в спеке 026 (T-15).
- Использует: `@swag/api-integration` (`createNodeRegistry`, `NodeRegistry`), `@swag/contracts` (`NodeManifest`).

## Спеки

- 021 — 4.7 (загрузчик, `bootNodeRegistry`), 4.9 (`NODE_PACKAGES`), AC-021-4, 17, 18.
- 026 — 4.4 (`packageOf`, `bootNodePackages`), REQ-026-14, AC-026-4.
