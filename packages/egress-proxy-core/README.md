# @swag/egress-proxy-core

Ядро исходящего прокси узлов (спека 026, 4.7). Решает одну задачу: пустить `CONNECT` узла дальше только по гранту, к хостам из `egress` и только к публичным адресам. Чистый TypeScript без Node API, env и сетевых клиентов. Зависимости: `@swag/contracts`.

## Задачи

- Проверить `CONNECT` по шагам 1–5 из 4.7: метод (`405 method`), заголовок `Basic base64("swag:" + token)` и подпись гранта (`407 auth`), срок `expiresAt` (`407 expired`), хост и порт по `egressMatches` (`403 host`), разрешение имени и публичность всех адресов (`502 resolve_failed`, `403 private_address`). Результат — `Decision`: при разрешении адрес первого `A`/`AAAA` и порт.
- Отличить публичный адрес от внутреннего (`isPublicAddress`): IPv4 и IPv6 диапазоны из 4.7, `::ffff:a.b.c.d` и IPv4-совместимые `::a.b.c.d` — по IPv4-правилу.
- Писать логи `egress allowed` (info) и `egress denied` (warn) с `invocationId`, `host`, `port` и причиной. Токен и заголовок не пишутся.

## Что внутри

- `createEgressProxyCore(deps)` — фабрика ядра, `deps`: `grants: GrantVerifier`, `resolver: Resolver`, `clock: Clock`, `logger: Logger`, необязательный `isPublic` (по умолчанию `isPublicAddress`, см. ниже).
- `authorize(method, target, proxyAuthorization)` — решение `Decision`.
- `isPublicAddress(address)` и `parseTarget(target)` — экспорт для тестов и оболочки.
- Порты `GrantVerifier`, `Resolver`, `Clock`, `Logger` объявлены здесь; реализация `GrantVerifier` — `createEgressGrants` в `@swag/adapter-crypto`, `Resolver` — `dns.promises.lookup` в оболочке `apps/egress-proxy`.
- Тесты: `test/authorize.test.ts` (AC-026-8, логи), `test/public-address.test.ts` (AC-026-9), `test/bench.test.ts` (NFR-026-2, 10 000 вызовов без DNS).

## Ключевые решения

- **Разбор вручную, без regex и `node:net`.** IPv4 и IPv6 (включая `::` и хвост `a.b.c.d`) разбираются `split` и проверками символов: ядро не может использовать Node API, а правила проекта запрещают regex в коде. Адрес, который не разобрался, считается непубличным (fail-closed).
- **`Basic` декодируется через `atob`.** Глобальный `atob` объявлен в `src/env.d.ts`, т.к. `lib ES2023` его не содержит (как `TextEncoder` в `llm-gateway-core`).
- **Порядок шагов жёсткий.** Каждый отказ — первый нарушенный шаг 4.7; тесты идут по нему. Пустой список адресов от резолвера — `502 resolve_failed`, а не `ok`.
- **Опция `isPublic` в deps (D-162).** Контракт 4.7 её не содержит; добавлена необязательной, нужна только тесту оболочки (AC-026-11), который должен разрешить адрес `127.0.0.1` эхо-сервера. В проде не передаётся.
- **Время — `Clock.now(): Date`**, как в `llm-gateway-core`; сравнение с `expiresAt` в миллисекундах.

## Ограничения

- IPv4-совместимые адреса `::a.b.c.d` проверяются по IPv4-правилу — строже буквы 4.7. Префикс NAT64 `64:ff9b::/96` не разбирается: адрес за ним считается публичным, если спека не добавит диапазон.
- Ядро не ограничивает время соединения и размер трафика — это делает оболочка (или будущие правки спеки).
- Проверка адреса — по адресу из ответа резолвера на момент `authorize`; повторного резолва при `connect` ядро не делает. Оболочка соединяется с этим же адресом.

## Связи

- Оболочка: `apps/egress-proxy` (`node:http`, порт `EGRESS_PROXY_PORT`).
- Гранты выпускает оркестратор (`createEgressGrants` в `@swag/adapter-crypto`, ключ `EGRESS_PROXY_KEY`).
- Сверка с `egress` — `egressMatches` из `@swag/contracts` (общая с SDK узлов).
- Спеки: [026](../../docs/spec/026-node-execution.md) (REQ-026-6, 4.7, AC-026-8, -9, -11, NFR-026-2), решение [D-162](../../docs/spec/questions.md).
