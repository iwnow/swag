# apps/ui

Папка фронтендов платформы. Каждый фронтенд собирается и деплоится отдельно и может быть на своей технологии; логика — в ядрах (`packages/ui-core` и др.), фронтенд только рисует.

## Что здесь сейчас

- [`shell/`](shell/README.md) — каркас с входом, регистрацией, шапкой и подгрузкой микрофронтендов (`@swag/shell`, спека 014, T-11).
- [`cabinet/`](cabinet/README.md) — личный кабинет на Angular (`@swag/cabinet`), Native Federation remote каркаса (спека 014, T-12): экран списка, формы и страницы роя, баланс; экспорт `./routes`, вход, шапка и стили — от каркаса.

## Compose

- `ui` — образ `apps/ui/shell/Dockerfile`, порт `127.0.0.1:${UI_PORT}`; `depends_on` с `service_healthy` на `api`, `identity` и `ui-cabinet`.
- `ui-cabinet` — образ `apps/ui/cabinet/Dockerfile`, порт не публикуется; healthcheck — `remoteEntry.json` на порту 4201.
- `ui-admin` и `ui-supervisor` — в compose нет, появятся с T-15 и T-16.

## Что будет

- Микрофронтенды `admin` и `supervisor` — спека 014 (T-15, T-16). Способ сборки — D-11.
- `landing` на Astro — вне MVP.

## Связи

- Workspaces npm: `apps/ui/*`.
- Логика: `@swag/ui-core`, `@swag/api-integration`, `@swag/contracts`.

## Ключевые решения

- Каждый фронтенд — отдельный каталог и npm-workspace (`apps/ui/*`); логика в ядрах, фронтенд только рисует.
- Папка не пакет: `apps/ui` без `package.json`.

## Спеки

- 000 — заглушка каталога. 001 — `cabinet`. 014 — каркас и остальные фронтенды.
