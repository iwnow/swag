# @swag/egress-proxy

Оболочка исходящего прокси узлов (спека 026, 4.7). Подключает ядро `@swag/egress-proxy-core` к `node:http`: принимает `CONNECT`, отдаёт решение ядра и соединяет узел с проверенным адресом. Fastify не используется.

## Задачи

- Принимать `CONNECT host:port` на `EGRESS_PROXY_PORT` и передавать метод, цель и `Proxy-Authorization` в `authorize`.
- Отказ ядра — статусная строка `HTTP/1.1 <status> <фраза>` и закрытие сокета. Разрешение — `HTTP/1.1 200 Connection Established`, двунаправленный pipe к `net.connect(port, address)`.
- Обычный HTTP-запрос (не `CONNECT`) — `405`.
- Здоровье: `GET /health` на `EGRESS_PROXY_HEALTH_PORT` — `200`, остальное — `404`. Порт не публикуется наружу, `compose` проверяет его `wget` изнутри контейнера.
- Собрать адаптеры: `Resolver` через `dns.promises.lookup(host, { all: true, verbatim: true })`, `GrantVerifier` через `createEgressGrants(EGRESS_PROXY_KEY)`, логгер и телеметрия по спеке 016.

## Что внутри

- `src/main.ts` — конфиг (`EgressProxyConfig`), телеметрия (`service: 'egress-proxy'`), сборка ядра и сервера, остановка по `SIGINT`/`SIGTERM`. Конфигурация с ошибкой — лог `config invalid` и выход с кодом 1 до приёма запросов.
- `src/server.ts` — `startEgressProxy({ core, host, port, healthPort })`: два `http`-сервера, учёт открытых туннелей для остановки. Порты `0` дают случайные (нужно тестам); возвращает фактические.
- `test/egress-proxy.test.ts` — AC-026-11: туннель к `allowed.test` через локальный эхо-сервер, `403` для `other.test`, `407` без верного токена, `405` для `GET`, `200` на `/health`.

## Ключевые решения

- **`node:http` и `connect`-событие, без Fastify.** Прокси не отдаёт REST, поэтому фреймворк не нужен; `CONNECT` не попадает в обработчик `request`, поэтому обычный запрос отдельно отвечает `405`.
- **Тест подменяет проверку адреса через `isPublic` (D-162).** В тесте `isPublic: () => true`, чтобы адрес `127.0.0.1` эхо-сервера считался публичным. В `main.ts` опция не передаётся: ядро использует `isPublicAddress`.
- **Ключ теста — 32 нулевых байта.** Он только для тестов; в `compose.yaml` и `.env` ключ задаётся отдельно (`EGRESS_PROXY_KEY`).
- **Переменные в compose — явным списком.** `egress-proxy` получает только то, что читает `EgressProxyConfig` и `BaseConfig`, без `env_file: .env` (как у `orchestrator`, D-73).
- **Имя сервиса в телеметрии.** `egress-proxy` добавлено в `ServiceName` (`@swag/contracts`, `log.ts`).

## Ограничения

- Нет таймаутов на простаивающие туннели и на `connect` к узлу: зависшее соединение держит сокет до закрытия одной из сторон. Лимита одновременных туннелей и закрытия по `expiresAt` гранта тоже нет — см. N-31 в [`docs/spec/notes.md`](../../docs/spec/notes.md).
- Адрес берётся из ответа резолвера один раз; повторного резолва при соединении нет.
- Ответ `502` при сбое соединения с проверенным адресом отдаётся только до установки туннеля; позже туннель просто рвётся.

## Связи

- Ядро: [`packages/egress-proxy-core`](../../packages/egress-proxy-core/README.md).
- Гранты: `createEgressGrants` в `@swag/adapter-crypto`; выпускает оркестратор (спека 026, 4.10, T-14).
- Сеть: сервис `egress-proxy` в `compose.yaml`, сети `default` (выход) и `nodes` (песочницы узлов, `internal`).
- Спеки: [026](../../docs/spec/026-node-execution.md) (REQ-026-6, 4.7, 4.11, AC-026-11), решение [D-162](../../docs/spec/questions.md).
