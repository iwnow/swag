# @swag/adapter-jose

Подпись и проверка токена доступа identity: JWT с `alg: EdDSA` (Ed25519) на `jose`. Спека 012, 4.7.

## Задачи

- Подписывать утверждения `AccessTokenClaims` закрытым ключом с `kid` (REQ-012-10).
- Проверять токен по открытому ключу без запроса в identity: подпись, `alg`, `kid`, `iss`, `aud`, `exp`, разбор утверждений (REQ-012-14).
- Выводить открытый ключ из закрытого для проверки самой identity (`publicKeyFromPrivate`).
- Проверка токена в сервисах (спека 024) подключит этот же verifier; в 012 его вызывает только `GET /auth/me` (REQ-012-13).

## Что внутри сейчас

- `createJoseSigner({ privateKeyPem, kid })` — `TokenSigner`: заголовок `{ alg: 'EdDSA', kid, typ: 'JWT' }`, `iss`, `aud`, `iat`, `exp` из утверждений.
- `createJoseVerifier({ publicKeyPem, kid })` — `TokenVerifier`: `null` на любой отказ (чужой `kid`, подпись, `alg`, `iss`, `aud`, срок, мусор, разбор `AccessTokenClaims`).
- `publicKeyFromPrivate(privateKeyPem)` — SPKI PEM.
- `test/jose.test.ts` — AC-012-19, REQ-012-10, REQ-012-14. Ключи создаются в тесте, фикстур с ключами нет.

## Ограничения

- Ключ один с одним `kid`: ротация и несколько активных ключей — после MVP (4.11, спека 012, «Не входит»).
- Ключи — PEM. Перевод `IDENTITY_JWT_PRIVATE_KEY` (base64 DER PKCS8) в PEM делает оболочка `apps/identity` (T-16).
- Сигнер не проверяет утверждения: их проверяет вызывающая сторона (`AccessTokenClaims` в ядре).

## Связи

- Порты: `TokenSigner`, `TokenVerifier` из `@swag/identity-core` (только типы).
- Схема утверждений: `AccessTokenClaims` из `@swag/contracts`.
- Использует: `jose` 6.2.12, `node:crypto` (разбор PEM).
- Потребители: `apps/identity` (T-16); проверка в сервисах — спека 024.

## Ключевые решения

- Ключи передаются в `jose` как `KeyObject` из `node:crypto`: разбор PEM синхронный, при создании адаптера видно ошибку ключа.
- `kid` проверяется отдельно от `jwtVerify`: `jose` не сверяет `kid` сам, а `alg` ограничен списком `['EdDSA']`, поэтому `alg: none` и другие алгоритмы отвергаются.
- Открытый ключ из закрытого — через `createPublicKey(...).export`, чтобы не держать второй ключ в конфиге (`IDENTITY_JWT_PUBLIC_KEY` нужен 024).

## Спеки

- 012 — REQ-012-10, REQ-012-14, AC-012-19, 4.7, 4.11; задача T-13.
