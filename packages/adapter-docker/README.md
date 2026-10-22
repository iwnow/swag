# @swag/adapter-docker

Адаптер порта `SandboxProvider` из `orchestrator-core` на Docker (dockerode). Шаблон → образ, метаданные → метки контейнера, env + `NATS_URL` из конфигурации адаптера.

## Задачи

- `create(spec)` — создать и запустить контейнер агента.
- `remove(id)` — остановить и удалить; нет такого контейнера — не ошибка.
- `list(match)` — id контейнеров по меткам; `true` — ключ есть с любым значением.

## Что внутри сейчас

- `createDockerSandboxProvider({ network, natsUrl, docker? })`.
- `test/docker.test.ts` — AC-001-22. Без доступного Docker пропускается с предупреждением; в CI обязателен.

## Ограничения

- Без монтирований, публикации портов и `Privileged` (4.6.3). Ресурсы, read-only rootfs, сеть на рой — спека 005.
- Доступ к Docker только у оболочки `orchestrator` (Q-1). Socket монтируется только туда.
- Пользователь — из образа (`node`).

## Связи

- Порт: `SandboxProvider` из `@swag/orchestrator-core` (только типы).
- Оболочка: `apps/orchestrator`.
- Конфигурация: `DOCKER_AGENT_NETWORK`, `DOCKER_AGENT_NATS_URL` ([4.9](../../docs/spec/001-walking-skeleton.md#49-переменные-окружения)).

## Ключевые решения

- `dockerode` 5.0.1 и `@types/dockerode` 4.0.2 (точные версии, `save-exact`; T-7).
- Метки контейнера = метаданные песочницы: поиск роя и сирот — через `listContainers` с фильтром `label` (`key=value` или `key`).
- `NATS_URL` добавляет адаптер, а не ядро (4.6.3): адрес — `DOCKER_AGENT_NATS_URL`.
- Удаление с `force: true`; `404` при удалении — не ошибка (порт требует идемпотентности).
- Проверено на Docker Desktop 29.x: AC-001-22 проходит на `alpine:3.22`, сеть `bridge`.

## Спеки

- 001 — 4.6.3, AC-001-22. Усиление — 005.
