# @swag/adapter-docker

Адаптер порта `SandboxProvider` из `orchestrator-core` на Docker (dockerode). Шаблон → образ, метаданные → метки контейнера, env + `NATS_URL`, `LLM_GATEWAY_URL`, `TRACEPARENT` и `OTEL_EXPORTER_OTLP_ENDPOINT` из конфигурации адаптера и текущего контекста трассировки.

## Задачи

- `create(spec)` — создать и запустить контейнер агента в спане `sandbox.create`.
- `remove(id)` — остановить и удалить в спане `sandbox.remove`; нет такого контейнера — не ошибка.
- `list(match)` — id контейнеров по меткам; `true` — ключ есть с любым значением.

## Что внутри сейчас

- `createDockerSandboxProvider({ network, natsUrl, llmGatewayUrl, otlpEndpoint?, docker? })`.
- `test/docker.test.ts` — AC-001-22, AC-016-10 и AC-022-17. Без доступного Docker пропускаются с предупреждением; в CI обязательны.

## Ограничения

- Без монтирований, публикации портов и `Privileged` (4.6.3). Ресурсы, read-only rootfs, сеть на рой — спека 005.
- Доступ к Docker только у оболочки `orchestrator` (Q-1). Socket монтируется только туда.
- Пользователь — из образа (`node`).
- Агент шлёт телеметрию в Collector по общей сети compose; закрытая сеть песочницы — спека 005 (D-14).

## Связи

- Порт: `SandboxProvider` из `@swag/orchestrator-core` (только типы).
- Оболочка: `apps/orchestrator`.
- Конфигурация: `DOCKER_AGENT_NETWORK`, `DOCKER_AGENT_NATS_URL` ([001, 4.9](../../docs/spec/001-walking-skeleton.md#49-переменные-окружения)), `DOCKER_AGENT_OTLP_ENDPOINT` ([016, 4.11](../../docs/spec/016-observability.md#411-переменные-окружения)), `DOCKER_AGENT_LLM_GATEWAY_URL` ([022, 4.8](../../docs/spec/022-agent-loop.md#48-env-агента)).
- Трассировка: `@opentelemetry/api`; тесты — `@swag/adapter-telemetry` (devDependency).

## Ключевые решения

- `dockerode` 5.0.1 и `@types/dockerode` 4.0.2 (точные версии, `save-exact`; T-7 спеки 001).
- Метки контейнера = метаданные песочницы: поиск роя и сирот — через `listContainers` с фильтром `label` (`key=value` или `key`).
- `NATS_URL`, `LLM_GATEWAY_URL`, `TRACEPARENT` и `OTEL_EXPORTER_OTLP_ENDPOINT` добавляет адаптер, а не ядро (022, 4.8, REQ-022-10; `TRACEPARENT` — D-83): `SandboxSpec` от ядра не меняется (4.6.3 спеки 001, 4.7 спеки 016). Других переменных телеметрии песочница не получает — ни адресов Grafana, Tempo и Loki, ни учётных данных (REQ-016-14).
- `TRACEPARENT` берётся внутри спана `sandbox.create`: родитель спана `agent.start` в агенте — создание его песочницы. Нет контекста — пустая строка; нет `otlpEndpoint` — пустой `OTEL_EXPORTER_OTLP_ENDPOINT` (агент тогда пишет логи только в stdout, D-18).
- `LLM_GATEWAY_URL` — из `llmGatewayUrl` (`DOCKER_AGENT_LLM_GATEWAY_URL`), по образцу `NATS_URL`. Адрес gateway в сети `default` compose: агенты (`DOCKER_AGENT_NETWORK=swag_default`) достают `llm-gateway` без смены сети. Токен `LLM_GATEWAY_TOKEN` приходит от ядра в `spec.env` и в этом адаптере не трогается; ключей провайдеров адаптер не знает (REQ-022-10).
- Спаны `sandbox.create` и `sandbox.remove` — `kind: client`, атрибуты `swarm.id`, `agent.id` (из метаданных `swag.swarm`, `swag.agent`) и `sandbox.id` после создания. Для `remove` id роя и агента адаптер помнит с `create`; у сирот прошлого запуска их нет.
- Удаление: сначала `stop` с грейсом 5 с (SIGTERM — агент закрывает NATS и сбрасывает телеметрию, REQ-016-8), затем `remove` с `force: true`. Без остановки force-удаление шлёт SIGKILL, и последние спаны и логи агента терялись (найдено ревью 016). `404` — не ошибка (порт требует идемпотентности), `304` при остановке — контейнер уже остановлен. Цена — уборка роя дольше на время остановки агентов.
- Проверено на Docker Desktop 29.x: AC-001-22 и AC-016-10 проходят на `alpine:3.22`, сеть `bridge`.
- Сверка с документацией (T-33 спеки 002, 2026-10-28). Вызовы проверены по Docker Engine API v1.52 (https://docs.docker.com/reference/api/engine/version/v1.52.yaml): `/containers/create` (`Env`, `Labels`, `HostConfig.NetworkMode`/`Privileged`/`Binds`/`PortBindings`), `/containers/{id}/stop` (query `t`), `/containers/{id}` DELETE (query `force`), `/containers/json` (`all`, `filters` — JSON `map[string][]string`, метка `label=key` или `label=key=value`). `docker-modem` 5.0.7 кодирует объектный `filters` в JSON. README `dockerode` 5.0.1 (https://github.com/apocas/dockerode) этих параметров не описывает; опора — Docker API. Типов для dockerode 5 отдельных нет (в пакете нет `types`); `@types/dockerode` 4.0.2 — последняя версия на npm, оставлена.

## Спеки

- 001 — 4.6.3, AC-001-22. Усиление — 005.
- 016 — 4.7, REQ-016-14, AC-016-10.
- 022 — 4.8, REQ-022-10, AC-022-17 (часть адаптера).
