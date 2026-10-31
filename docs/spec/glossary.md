# Глоссарий

Термин в спеках и документации → имя в коде. В коде используются только имена из правой колонки. Новый термин сначала добавляется сюда.

| Термин | В коде | Определение |
|---|---|---|
| Рой | `Swarm`, `swarmId` | Группа агентов, собранная под одну задачу пользователя. Имеет бюджет, свою сеть и свой account шины. |
| План роя | `SwarmPlan` | Structured output координатора: роли, модели, скиллы, связи, бюджет. Исполняется оркестратором после валидации. |
| Агент | `Agent`, `agentId` | Агентный цикл в одной песочнице с одной ролью из плана роя. |
| Агентный цикл | `AgentLoop`, `runAgentLoop` | Цикл «вызов модели → вызовы инструментов → результаты» на OpenAI-формате. Не знает о рое: всё получает через контекст вызова (спека 022, 4.2). |
| Контекст вызова | `AgentCallContext` | Вход агентного цикла: модель, системный промпт, история, новое сообщение, инструменты, лимиты `maxSteps`, `maxTokens` (022, 4.2). |
| Итог цикла | `AgentLoopResult` | `text`, `stopped`, `yielded`, `max_steps`, `model_error` + добавленные сообщения и число шагов (022, 4.2; `yielded` — 030, 4.1). |
| Шаг цикла | `AgentStep`, `onStep` | Описание ответа модели для публикации: номер, текст, имена инструментов (022, 4.2). |
| Порт модели | `ChatModel`, `ChatModelRequest`, `ChatModelResult`, `ChatModelErrorCode` | Порт `agent-core`: один вызов модели в формате OpenAI; не бросает, ошибка — `ok: false` (022, 4.2). |
| Сообщения модели | `ChatMessage`, `ToolCall`, `ToolDefinition` | Подмножество OpenAI Chat Completions в `agent-core` (022, 4.2). |
| Инструмент агента | `AgentTool`, `ToolOutcome` | Определение инструмента и его исполнение; `stop` в результате завершает цикл, `yieldTurn` уступает ход (022, 4.2; `yieldTurn` — 030, 4.1). |
| Уступить ход | `yieldTurn`, итог `yielded` | Флаг результата инструмента: цикл заканчивается после шага, агент ждёт следующего сообщения; успешный `send_message` уступает ход (030, 4.1). |
| Непрочитанное сообщение | `unreadMessageIds` | `bus.message`, для которого к концу роя в ленте нет `agent.working` с тем же `messageId`; в ленте UI — «не прочитано» (030, 4.4). |
| Инструменты роя | `send_message`, `finish` | «Написать агенту» — участнику роя; «завершить» — только у агента-входа, итог роя (022, 4.5). |
| Агент-вход | `ENTRY_AGENT_ID`, `AGENT_ENTRY` | `agent-1`: получает задачу от пользователя, только его `finish` завершает рой (022, Q-3). |
| Напоминание агенту-входу, ожидаемые ответы | `awaiting` | Агент-вход закончил ход текстом и не ждёт ответов участников (`awaiting` пусто) — один раз за ход получает напоминание вызвать `finish`; повторный текст — результат роя, кроме случаев, когда после напоминания появились ожидаемые ответы (`agent.idle`) или текст пуст (`empty_result`) (022, 4.4, Q-7, D-82, D-85). |
| Текст напоминания агенту-входу | `ENTRY_REMINDER` | Шаблон 4.5 для шага 5 алгоритма 4.4: `user`-сообщение, которое агент-вход получает один раз за ход после итога `text` без ожидаемых ответов (022, 4.4, 4.5). |
| Код `max_tokens` | `max_tokens` (`ChatModelErrorCode`) | Ответ модели обрезан по `max_tokens` (`finish_reason: length`): ошибка модели даже при тексте или вызовах; агент уходит в `agent.failed` `model_error:max_tokens` (022, 4.3, D-85). |
| Причина `empty_result` | `empty_result` | Причина `agent.failed` агента-входа: после напоминания итог `text` пустой или `null` при пустом `awaiting` (022, 4.4, шаг 5, D-85). |
| Участник роя | `AgentPeer`, `AGENT_PEERS` | Другой агент роя для промпта и `send_message`: id, имя, роль (022, 4.4). |
| Промпт и инструменты агента роя | `systemPrompt`, `inboxMessage`, `swarmTools`, `PromptAgent` | Чистые функции `agent-core`: системный промпт по шаблону, входящее сообщение `role: user`, инструменты `send_message` и `finish` (022, 4.5). |
| Модель платформы для формы | `PlatformModel` | `chat-small`, `chat-large` — выбор модели агента в форме роя (022, 4.1). |
| Шаг агента (событие) | `agent.step` | Событие на каждый ответ модели: `messageId`, `stepIndex`, текст, `toolCalls` (022, 4.1). |
| Агент ждёт | `agent.idle` | Конец хода без `finish`: агент ждёт следующего сообщения (022, 4.1). |
| Падение агента в рое | `agent_failed` | Причина `swarm.failed`: `agent.failed` любого агента, `detail = "<agentId>: <reason>"` (022, 4.9). |
| Рой прерван перезапуском api | `api_restarted` | Причина `swarm.failed`: рой был `starting` или `running`, когда `api` перезапустился; закрывается при старте `api` (003, 4.2). |
| Адаптер OpenAI | `packages/adapter-openai`, `createOpenAiChatModel`, `OpenAiChatModelOptions` | `ChatModel` на OpenAI SDK, ходит только в `llm-gateway` (022, 4.3). |
| Маркер вызовов фейка | `__tool_calls__` | Текст после маркера — JSON вызовов инструментов, которые вернёт фейковый провайдер (022, 4.7). |
| Строка шага | `formatAgentStep` | Функция `ui-core`: строка `agent.step` в ленте роя (022, 4.10). |
| Данные шага агента | `AgentStepData` | Тип `data` события `agent.step`, выведен из контракта, экспорт `ui-core` (022, 4.10). |
| Координатор | `Coordinator` | Компонент, который по задаче пользователя генерирует план роя. |
| Оркестратор | `Orchestrator` | Компонент, который исполняет план: песочницы, сети, ключи, accounts шины, уборка. |
| Песочница | `Sandbox`, `sandboxId` | Изолированная одноразовая среда выполнения (контейнер, позже microVM). Выполняет агента или любую другую работу: скрипт, сборку, тесты. |
| Вид нагрузки | `swag.kind` | Что выполняется в песочнице: `agent`, позже другие. Ключ метаданных есть у каждой песочницы платформы. |
| Провайдер песочниц | `SandboxProvider` | Интерфейс создания и управления песочницами. Реализации: `DockerProvider`, позже `FirecrackerProvider`. |
| Тёплый пул | `WarmPool` | Заранее созданные песочницы для быстрого старта. |
| Рабочая папка | `/work`, `workVolume` | Docker volume агента с его файлами. |
| Снимок | `Snapshot` | Архив рабочей папки в S3 на границе шага: `swarmId/agentId/step-N`. |
| Шаг | `Step`, `stepIndex` | Одна итерация агентного цикла: вызов модели и выполнение её `tool_calls`. |
| Скилл | `Skill` | Версионированная папка с `SKILL.md`, скриптами и шаблонами. |
| Реестр скиллов | `SkillRegistry` | Хранилище и каталог скиллов. |
| Узел | `Node`, `nodeId` | Элемент графа процесса: экземпляр типа узла с настройками. Виды — триггер, канал, коннектор, LLM-агент, программа, человек. |
| Вид узла | `NodeKind` | `trigger`, `channel`, `connector`, `llm-agent`, `program`, `human`; задаёт операции, которые узел реализует. |
| Тип узла | `NodeType`, `type@version` | Плагин узла из реестра: манифест и код. Граф ссылается на тип с версией. |
| Манифест узла | `NodeManifest` | Описание типа узла: вид, схемы настроек, входа, выхода и операций, credentials, `egress`. |
| Реестр узлов | `NodeRegistry` | Хранилище и каталог типов узлов для редактора, координатора и оркестратора. |
| Контекст исполнения узла | `NodeContext` | Всё, что видит код узла: настройки, секреты через порт, HTTP через исходящий прокси, логгер, состояние узла, запись стоимости. |
| SDK узлов | `@swag/node-sdk` | Пакет с типами контракта узла и тестовой обвязкой для разработки узлов без платформы. |
| Шина | `Bus` | NATS: обмен сообщениями агентов внутри роя. |
| Account шины | `BusAccount` | Изолированный NATS account одного роя. |
| Общее состояние роя | `SwarmState` | NATS KV роя, обновление через compare-and-set. |
| LLM Gateway | `llm-gateway`, `LlmGatewayCore` | Единственная точка выхода к моделям: OpenAI-совместимый API, ключи провайдеров за ним, стоимость вызова по ценам платформы, событие `llm.call` (спека 002). |
| LiteLLM | `LiteLLM`, `LlmUpstream`, `@swag/adapter-litellm` | Адаптер форматов провайдеров за LLM Gateway; виртуальные ключи, бюджеты и БД LiteLLM не используются (D-21, спека 002). |
| Профиль моделей | `LLM_PROFILE` | `test`, `dev`, `test-pay`, `prod`; `test-pay` — дешёвые платные модели без reasoning для платных проверок (032): каталог `infra/llm/<профиль>/` с конфигом LiteLLM и ценами. |
| Модель платформы | `ModelId` | Имя модели в плане и запросе (`chat-small`, `chat-large`), одинаковое во всех профилях; провайдерскую модель за ним выбирает профиль. |
| Каталог моделей | `ModelCatalog`, `CatalogModel` | Модели профиля с ценами платформы, `models.json`. |
| Цены модели | `ModelPrices`, `PricePerMTok` | USD за 1 млн токенов: вход, вход из кэша, выход — десятичные строки. |
| Использование токенов | `LlmUsage` | `promptTokens`, `cachedPromptTokens`, `completionTokens` из `usage` ответа. |
| Вызов модели | `llm.call`, `LlmCallData`, `LlmCallStatus`, `callId` | Событие на каждый запрос, ушедший к LiteLLM: модель, `usage`, `costMicroUsd`, `providerCostMicroUsd`, задержка, статус `ok` / `error` / `aborted`. |
| Стоимость вызова | `costMicroUsd` | Функция `llm-gateway-core`: стоимость по `usage` и ценам модели, micro-USD, округление вверх (спека 002, 4.3). |
| Разбор usage | `parseUsage` | Функция `llm-gateway-core`: `usage` ответа OpenAI → `LlmUsage`; нет `prompt_tokens`/`completion_tokens` или они не целые ≥ 0 — `null`. |
| Тело запроса к gateway | `ChatRequest`, `CLIENT_CREDENTIAL_FIELDS`, `parseChatRequest` | Схема `ChatRequest` (`model`, `messages`, `stream`, `stream_options`; лишние поля проходят). `CLIENT_CREDENTIAL_FIELDS` — поля ключа и адреса провайдера, которых в теле быть не может (REQ-002-18). `parseChatRequest` → `{ ok, value }` или `{ ok: false, message }` по таблице 4.6 (спека 002, 4.2). |
| Ядро LLM Gateway | `@swag/llm-gateway-core` | Пакет `packages/llm-gateway-core`: расчёт стоимости и разбор usage; в 002 — ядро `llm-gateway`. |
| Порт апстрима | `UpstreamFailure`, `UpstreamResponse`, `UpstreamStream`, `UpstreamStreamError`, `UpstreamModels`, `UpstreamSignal` | Типы порта `LlmUpstream` в `llm-gateway-core`: отказ провайдера (`http` с `message` без секретов, `network`, `timeout`), результат обычного вызова, потока (`stream`, T-11; обрыв после старта — `UpstreamStreamError`, в т.ч. `aborted`) и списка моделей (`listModels`, T-10), сигнал отмены структурно (спека 002, 4.4; D-47). |
| Фабрика ядра LLM Gateway | `createLlmGatewayCore`, `LlmGatewayDeps`, `LlmGatewayCore`, `CompleteResult`, `CheckUpstreamResult`, `ModelList` | Фабрика ядра `llm-gateway-core` (`info`, `listModels`, `checkUpstream`, `complete`) и её зависимости; `complete` в T-13 — заглушка (спека 002, 4.4). |
| Порты ядра LLM Gateway | `EventPublisher`, `Ids` | Порты в `llm-gateway-core`: публикация события, генератор id (`Ids` по 4.4; в других ядрах — `IdGenerator`, D-55); собираются оболочкой (спека 002, 4.4). |
| Адаптер LiteLLM | `createLiteLlmUpstream`, `LiteLlmOptions` | Фабрика порта `LlmUpstream` в `adapter-litellm` (спека 002, 4.5). |
| Спан LiteLLM | `litellm.chat` | Клиентский спан вызова LiteLLM в `adapter-litellm` у `complete` и `stream`: модель, поток, статус ответа, `gen_ai.usage.*`; текстов нет (спека 002, 4.5). |
| Редактирование секретов | `redact` | Функция `adapter-litellm`: каждое вхождение секрета в тексте заменяется на `***`; пустые секреты игнорируются (спека 002, 4.5, REQ-002-11). |
| Фактическая стоимость провайдера | `providerCostMicroUsd`, `parseProviderCost` | Сколько вызов стоил платформе у провайдера по её ключу, из `usage.cost` ответа (OpenRouter), в micro-USD. Только для счёта платформы (D-38); списание с организации — `costMicroUsd` по тарифу. |
| Код ошибки gateway | `GatewayErrorCode` | `unauthorized`, `invalid_caller`, `invalid_request`, `model_not_found`, `caller_not_registered`, `model_not_allowed`, `swarm_budget_exceeded`, `agent_budget_exceeded`, `upstream_bad_request`, `rate_limited`, `upstream_error`, `upstream_timeout` (002, 004 4.1, 4.12). |
| Ошибка в потоке gateway | `swag_gateway_error` | Значение `type` в payload `{"error":{message, type, code}}`, которым поток завершается после обрыва апстрима (спека 002, 4.4, шаг 5; T-18). |
| Вызывающий gateway | `LlmCaller`, `SWARM_ID_HEADER`, `AGENT_ID_HEADER` | `swarmId` и `agentId` из заголовков `x-swag-swarm-id`, `x-swag-agent-id` (002, Q-3). С 004 gateway пропускает только вызывающих из регистрации роя (004, 4.2, Q-2). |
| Фейковый провайдер | `llm-fake`, `startFakeProvider` | OpenAI-совместимый сервер для тестов и профиля `test`, `infra/llm/fake-provider`. |
| Сеть LLM | `llm` (сеть compose) | Обычная bridge-сеть compose (4.8), в которой живут `litellm` и `llm-fake`; `llm-gateway` входит в неё и в `default`. Порт `litellm` не публикуется. |
| Запись запроса к фейку | `FakeRequest` | Что фейк записал о запросе: `path`, `headers`, `body`, `closedByClient`; тесты читают список `requests`. |
| Маркер сценария фейка | `__no_usage__`, `__no_cost__`, `__fail_500__`, `__fail_429__`, `__fail_400__`, `__slow_chunks__`, `__cut__`, `__hang__` | Текст в последнем сообщении `messages` выбирает ответ фейка (4.12). |
| Ledger | `LedgerEntry`, `ledger_entries`, `LedgerReport` | Журнал денежных операций: в 004 — одна запись на вызов модели (`callId`, `kind: llm`, `amountMicroUsd` ≥ 0, основание списания, фактическая стоимость провайдера); пополнения и compute — 013. Деньги — целые micro-USD. |
| Пользователь | `User`, `userId` | Тот, кто работает с платформой через личный кабинет: свой баланс, свои рои. |
| Организация | `Organization`, `orgId`, `organizations`, `AuthOrganization` | Команда клиента на платформе: пользователи, их рои и расходы. Пользователь — ровно в одной организации, у супервизора её нет (012, Q-8); видимость — 024, баланс — D-10. |
| Администратор организации | роль `admin` | Управляет своей организацией: её пользователи и роли, рои и расходы. Чужие организации не видит. |
| Супервизор | роль `supervisor`, фронтенд `apps/ui/supervisor` | Владелец платформы: вся платформа — организации, пользователи, пополнение балансов, цены, лимиты, все рои. |
| Учётные данные | `Email`, `Password`, `UserId`, `OrgId`, `OrganizationName`, `LoginRequest`, `RegistrationConfirmRequest`, `AuthErrorCode` | Схемы регистрации, входа и кодов ошибок identity: email приводится к нижнему регистру, пароль 10–128 символов без `trim` (012, Q-10, 4.1). |
| Роль | `Role` | Именованный набор прав. В MVP — `user`, `admin`, `supervisor`. |
| Право | `Permission`, `ROLE_PERMISSIONS`, `can`, `forbidden`, `not_found` | Разрешение на действие (нет права — `forbidden`, объект вне области видимости — `not_found`), строка `<область>.<действие>`: `swarm.create`, `swarm.read`, `swarm.stop`, `user.manage`, `organization.read` (024, 4.1); `balance.topup` — 013. |
| Вызывающий | `Actor`, `actorFromClaims`, `authenticate` | Кто вызывает операцию ядра: `userId`, `orgId`, `role`, `permissions`; ядро собирает его из токена доступа и данных хранилища (роль и организация — из хранилища), внутренняя `authenticate` проверяет токен и отзыв (024, 4.1, 4.8). |
| Видимость роя | `orgId`, `createdBy` в `swarm.created` и `SwarmView`, `not_found` | `user` видит свои рои, `admin` — рои своей организации целиком, `supervisor` — все; чужой рой — `404` (024, 4.3, 4.4). |
| Управление пользователями | `ManagedUser`, `UserList`, `UserUpdate`, `OrgRole`, `listUsers`, `updateUser`, `user_updated`, `OrganizationSummary`, `OrganizationList`, `listOrganizations` | Администратор меняет роль и блокирует пользователей своей организации, супервизор — любых, кроме супервизоров (024, 4.7). |
| Приглашение | `invitations`, `InvitationRequest`, `InvitationAcceptRequest`, `inviteUser`, `addInvitation`, `acceptInvitation`, `IDENTITY_INVITE_URL`, `IDENTITY_INVITE_TTL_S`, `user_invited`, `invite_invalid_token`, `INVITATION_MAIL_SUBJECT`, `invitationMailText` | Письмо со ссылкой: приглашённый задаёт пароль и попадает в организацию с ролью из приглашения (024, 4.8). |
| Блокировка пользователя | `blocked_at`, `blockedAt`, `tokens_valid_after`, `tokensValidAfter`, `user_blocked`, `login_blocked` | Заблокированный не входит, его сессии отозваны, токены не принимаются, активные рои остановлены (024, 4.8). |
| Отзыв токенов | `tokens_valid_after`, `TokenRevocation`, `TokenRevocationList`, `tokenRevocations`, `GET /internal/token-revocations`, `IDENTITY_INTERNAL_TOKEN`, `RevocationSync`, `createRevocationSync`, `API_REVOCATION_POLL_MS`, `API_REVOCATION_MAX_STALE_MS`, `auth_unavailable`, `auth_failed`, `revocations_sync_failed`, `revocation_block_failed` | Токен с `iat` раньше `validAfter` недействителен; `api` забирает список у identity раз в 5 с и отказывает при устаревшем списке (024, 4.12). |
| Остановка роёв пользователя | `stopSwarmsOfUser`, `user_swarms_stopped` | `api` останавливает активные рои заблокированного пользователя (024, 4.4). |
| Внутренний токен оркестратора | `ORCHESTRATOR_TOKEN`, `ServiceToken` | Bearer, которым `api` вызывает оркестратор; без него запуск и остановка роя отклоняются (024, 4.13). |
| Уборка identity | `purgeExpired`, `purge`, `RETENTION_MS`, `identity_purged`, `identity_purge_failed` | Удаление просроченных подтверждений, приглашений и закрытых сессий старше 7 суток, раз в час (024, 4.9). |
| Сессия кабинета | `AuthApi`, `AuthSessionKeeper`, `createAuthSessionKeeper`, подпротоколы `swag.v1`, `swag.bearer.<jwt>` | Токен доступа в памяти страницы, один `refresh` на все `401`, токен в подпротоколе WebSocket (024, 4.6, 4.15). |
| Identity | `apps/identity`, `@swag/identity-core`, `createIdentityCore`, `IdentityCore`, `IdentityCoreDeps`, `RequestMeta`, `IdentityError`, `IdentityConfig`, `startIdentityCore`, `startOrExit`, `AppSettings`, `buildApp`, `Result` (тип результата ядра, форма как в `api-core`) | Сервис пользователей, регистрации, входа, сессий и токенов (012); управление пользователями, отзыв токенов и проверка доступа — 024. |
| Токен доступа | `accessToken`, `AccessTokenClaims` | Короткоживущий JWT на EdDSA (Ed25519) с `kid`; утверждения `sub`, `org`, `role`, `iss: swag-identity`, `aud: swag`; сервисы проверяют его сами, без запроса в identity (012, 4.1). |
| Регистрация компании | `requestRegistration`, `RegistrationRequest`, `POST /auth/registrations` | Ввод email: письмо со ссылкой подтверждения или «аккаунт уже есть», ответ одинаковый `202` (012, 4.2). |
| Подтверждение регистрации | `confirmRegistration`, `RegistrationConfirmRequest`, `email_confirmations`, `invalid_token`, `email_taken` | Одноразовый токен из письма + пароль + название компании → организация и её `admin` одной транзакцией (012, 4.2, 4.3). |
| Сессия, токен обновления | `sessions`, `refreshToken`, cookie `swag_refresh`, `rotateSession`, `AuthRefreshed`, `invalid_refresh_token` | Сессия входа; непрозрачный токен в httpOnly cookie, меняется при каждом `POST /auth/refresh`, повтор старого отзывает сессию (`refresh_reuse_detected`) (012, 4.3, 4.5). |
| Ответ входа | `AuthSession`, `IssuedSession`, `AuthUser`, `AuthMe`, `invalid_credentials` | Токен доступа, срок, пользователь и организация; `refreshToken` — только в cookie (012, 4.1, 4.2). |
| Хранилище identity | `IdentityStore`, `StoredUser`, `StoredOrganization`, `createPostgresIdentityStore`, `createMemoryIdentityStore`, `MemoryIdentityStore`, `identityStoreContract` | Порт `identity-core`: пользователи, организации, подтверждения, сессии (012, 4.3). |
| Хэшер паролей | `PasswordHasher`, `createArgon2Hasher`, `@swag/adapter-crypto` | argon2id `m=19456, t=2, p=1` на `@node-rs/argon2` (012, 4.7). |
| Непрозрачный токен | `OpaqueTokens`, `createNodeOpaqueTokens` | 32 случайных байта base64url и их SHA-256 для хранения: токены подтверждения и обновления (012, 4.3). |
| Подпись и проверка токена | `TokenSigner`, `TokenVerifier`, `createJoseSigner`, `createJoseVerifier`, `jwtKeys`, `publicKeyFromPrivate`, `@swag/adapter-jose`, `IDENTITY_JWT_PRIVATE_KEY`, `IDENTITY_JWT_PUBLIC_KEY`, `npm run identity:keys` | JWT EdDSA на `jose`; verifier подключают сервисы в 024 (012, 4.7, 4.11). |
| Порт отправки почты | `Mailer`, `MailMessage`, `createSmtpMailer`, `@swag/adapter-smtp`, `createMemoryMailer`, `MemoryMailer`, `mail_unavailable`, `CONFIRM_MAIL_SUBJECT`, `ALREADY_REGISTERED_MAIL_SUBJECT`, `ALREADY_REGISTERED_MAIL_TEXT`, `confirmMailText`, `INVITATION_MAIL_SUBJECT`, `invitationMailText` | Отправка писем identity; SMTP на `nodemailer` (012, 4.3, 4.7). Темы и тексты писем — константы `identity-core` (012, 4.6; приглашение — 024, 4.8). |
| Перехватчик почты | `mailpit` (сервис compose), `MAILPIT_UI_PORT` | Mailpit в разработке: принимает SMTP, письма видны в UI и API на `127.0.0.1` (012, 4.11). |
| Ограничитель частоты | `RateLimiter`, `createMemoryRateLimiter`, `MemoryRateLimiter`, `RATE_LIMITS`, `rate_limited` | Фиксированное окно по ключу `register:*`, `confirm:*`, `login:*`; сверх лимита — `429`. Лимиты — константа `RATE_LIMITS` в `identity-core` (012, 4.8). |
| Ошибки ядра identity | `identity_operation_failed`, `mail_send_failed`, `confirm_invalid_token`, `login_failed` | Лог ядра identity: неожиданное исключение операции (`internal_error`) и отказ почты (`mail_unavailable`); адрес и `err` с адресом в лог почты не пишутся (012, 4.2, 4.6, D-115). |
| Вход и защита от перебора | `dummyHash`, `issueSession` | Хэш от случайной строки для проверки пароля на неизвестный email: вход на неизвестный email тратит столько же времени, сколько на существующий (012, 4.2). |
| Первый супервизор | `ensureSupervisor`, `IDENTITY_SUPERVISOR_EMAIL`, `IDENTITY_SUPERVISOR_PASSWORD`, `supervisor_created` | Создаётся при старте identity из `.env`, если супервизора нет (012, Q-3). |
| Баланс | `Balance`, `balanceMicroUsd` | Остаток денег пользователя по предоплате: сумма его записей ledger. |
| Пополнение | `TopUp` | Запись ledger, увеличивающая баланс. В MVP делает супервизор. |
| Резерв бюджета | `budget_holds`, `holdMicroUsd` | В 004 — верхняя оценка стоимости вызова модели, зарезервированная из бюджета роя и агента до обращения к LiteLLM и закрытая списанием (004, 4.3); резерв бюджета роя из баланса — 013. |
| Фронтенд платформы | `apps/ui/<имя>` | Отдельно собираемое и деплоимое веб-приложение в `apps/ui/`; технология своя у каждого. |
| Каркас | `apps/ui/shell` | Фронтенд входа и навигации; подгружает микрофронтенды по правам пользователя. Спека 014. |
| Микрофронтенд | remote каркаса | Фронтенд, который каркас подгружает во время работы: `cabinet`, `admin`, `supervisor`. Способ сборки — D-11. |
| Личный кабинет | `apps/ui/cabinet`, `@swag/cabinet` | Экраны пользователя: баланс, операции, рои, агенты. В 001 — самостоятельное приложение с экранами роя. |
| Админка | `apps/ui/admin` | Микрофронтенд администратора организации: пользователи и роли организации, её рои и расходы. Кнопку «Админка» каркас показывает по правам. |
| Лендинг | `apps/ui/landing` | Презентационная страница проекта на Astro. Вне MVP. |
| Событие | `PlatformEvent` | Запись потока событий: `swarm.created`, `llm.call`, `bus.message` и т. д. Хранится с номером `seq`. |
| Входное событие | `PlatformEventInput` | Событие в том виде, в каком его публикуют в шину, без `seq`. Номер назначает `api` при приёме. |
| Номер события | `seq` | Сквозной номер события внутри роя: 1, 2, 3… без пропусков. По нему клиент догоняет поток (`after`). |
| Роль агента | `AgentSpec.role` | Текст обязанностей агента в рое. Не путать с ролью пользователя (`Role`). |
| Черновик агента | `AgentDraft` | Агент в запросе пользователя: имя и роль, без id. |
| Описание агента | `AgentSpec` | Агент роя с id `agent-1…agent-N`, именем и ролью. |
| Запрос на рой | `SwarmCreateRequest` | Тело создания роя: задача и упорядоченный список агентов. |
| Запуск роя | `SwarmLaunch` | Команда `api` оркестратору поднять рой: `swarmId`, задача, агенты. |
| Статус роя | `SwarmStatus` | `starting`, `running`, `completed`, `stopped`, `failed`. |
| Итоговый статус роя | `completed`, `stopped`, `failed` | Окончательный: после него события двигают только `lastSeq`, статус, `result` и `failure` не меняются (003, REQ-003-7, 4.3). |
| Статус агента | `AgentStatus` | `starting`, `idle`, `working`, `done`, `stopped`, `failed`. |
| Проекция роя | `SwarmView`, `applyEvent`, `projectSwarm` | Состояние роя, вычисленное из его событий одной чистой функцией: статусы, счётчики сообщений, рёбра по фактическим сообщениям, результат. Живёт в `@swag/api-integration`. |
| Число шагов агента | `steps` (поле агента в `SwarmView`) | Число событий `agent.step` агента, то есть вызовов модели за всю жизнь агента (022, 4.6). |
| Общая логика API | `@swag/api-integration` | Пакет чистой логики, общей для `api-core` и `ui-core` (проекция роя); подчиняется правилам ядра, входит в белый список зависимостей ядер. |
| Сводка роя | `SwarmSummary` | Строка списка роёв: задача, статус, число агентов, время. |
| Сообщение шины | `BusMessage` | Сообщение агенту: `from` (агент или `user`), `to`, текст. |
| Входящие агента | `inbox`, `inboxSubject()` | Subject `swarm.<swarmId>.agent.<agentId>.inbox`, на который подписан агент. |
| Отправитель «пользователь» | `from: 'user'` | Сообщение с задачей, которое оркестратор от имени пользователя отправляет первому агенту. |
| Эстафета | relay | Детерминированный сценарий агента без LLM (спека 001): дописать строку от своей роли и передать следующему в цепочке. Снято спекой 022: агент роя ведёт ход через LLM (4.4). |
| Цепочка | `AGENT_NEXT`, `edges` | Порядок агентов роя: `agent-k` передаёт результат `agent-(k+1)`, последний отдаёт результат роя. Снято спекой 022: `AGENT_NEXT` удалён (4.8), связи — `AgentPeer` и `send_message`. |
| Хранилище роёв | `SwarmStore` | Порт `api-core` для событий и состояния роёв. В 001 — в памяти, с 003 — Postgres; с 003 методы асинхронные (003, 4.2). |
| Очередь записи роя | `commit`, цепочка `Promise` по `swarmId` | Записи событий одного роя идут по очереди: `seq` = последний номер + 1, без пропусков и повторов; разные рои пишутся параллельно (003, REQ-003-3). |
| Подписка с буфером | `subscribe`, буфер подписчика | Подписка регистрируется до чтения истории; события, записанные во время чтения, копятся и отдаются после истории, каждое — ровно один раз по возрастанию `seq` (003, REQ-003-4). |
| Хранилище роёв на Postgres | `packages/adapter-postgres`, `createPostgresSwarmStore`, `runMigrations` | Адаптер `SwarmStore` на Postgres и применение миграций из `migrations/` (003, 4.4). |
| Таблицы роёв | `swarms`, `swarm_events` | Проекция роя (`view` в `jsonb`, статус, `last_seq`) и события роя по `(swarm_id, seq)` (003, 4.4). |
| Закрытие прерванных роёв | `closeInterrupted`, `api_restarted` | При старте `api` рои в `starting`/`running` закрываются `swarm.failed` с причиной `api_restarted` (003, 4.2). |
| База для тестов | `POSTGRES_TEST_URL` | Postgres для тестов адаптера и `apps/api`; без неё тесты пропускаются (003, 4.6). |
| Срок хранения телеметрии | `TELEMETRY_RETENTION` | Срок хранения Loki, Tempo и Prometheus в `lgtm`, формат `<часы>h`, не меньше `24h` (003, 4.7). |
| Клиент оркестратора | `OrchestratorClient` | Порт `api-core` для запуска и остановки роя в оркестраторе. |
| Спецификация песочницы | `SandboxSpec` | Что создать, без привязки к технологии: шаблон, env, метаданные. Сеть и адрес NATS — конфигурация адаптера. |
| Шаблон песочницы | `template`, `AGENT_TEMPLATE` | Окружение агента в терминах провайдера: для Docker — тег образа, для microVM — rootfs, для E2B — id шаблона. |
| Метаданные песочницы | `metadata` | Пары ключ-значение на песочнице (`swag.kind`, `swag.swarm`, `swag.agent`), по которым `list` находит песочницы роя и сирот. В Docker — метки контейнера. |
| Песочница-сирота | `cleanupOrphans` | Песочница платформы (с метаданными `swag.kind`), оставшаяся от прошлого запуска оркестратора; удаляется при его старте. |
| Часы, генератор id, лог | `Clock`, `IdGenerator`, `Logger` | Порты ядра для времени, UUID и логов, чтобы тесты управляли ими. Снято спекой 022: `Timers` удалён — ход агента не ждёт таймера (4.4, `AGENT_STEP_DELAY_MS` удалён). `Logger` пишет с контекстом (`swarmId`, `agentId`), `traceId` добавляет адаптер. В ядре 002 `Clock.now()` возвращает `Date`, а порт id называется `Ids` по 4.4 спеки 002 — см. D-55. |
| Трейс | `traceId`, `spanId` | Цепочка операций одного запроса через все сервисы, шину и песочницы (OpenTelemetry, W3C `traceparent`). `traceId` есть в конверте события платформы. |
| Контекст трассировки | `traceparent`, `TRACEPARENT` | Заголовок W3C, которым `traceId` передаётся в HTTP и сообщениях NATS; в песочницу — env `TRACEPARENT`. |
| Структурный лог | `LogRecord` | JSON-запись лога одной схемы во всех сервисах: время, уровень, сервис, сообщение, `traceId`, `spanId`, `swarmId`, `agentId`, ошибка. |
| Идентификатор трейса | `TraceId` | Схема `traceId` в `@swag/contracts`: 32 hex-символа в нижнем регистре, не нули (W3C). Спека 016. |
| Уровень лога, имя сервиса | `LogLevel`, `ServiceName` | `debug`, `info`, `warn`, `error`; `api`, `orchestrator`, `agent`. Поля `level` и `service` в `LogRecord`. |
| Ошибка в логе | `LogError`, `err` | Поле `err` записи лога: тип, сообщение, стек, причина. |
| Контекст лога | `LogContext` | Второй аргумент методов `Logger`: `swarmId`, `agentId`, `err` и прочие поля — только id, числа, перечисления. |
| Порт контекста трассировки | `TraceContext`, `currentTraceId()` | Порт ядра: текущий `traceId` или `null`. Ядро переносит его в конверт события как непрозрачную строку. Реализация — `adapter-telemetry`. Спека 016, Q-1. |
| Адаптер телеметрии | `packages/adapter-telemetry`, `startTelemetry`, `Telemetry`, `inSpan`, `currentTraceparent` | Пакет оболочек: OpenTelemetry SDK, логгер, `TraceContext`, спаны и перенос `traceparent`, сброс при остановке. |
| HTTP-сервер с трассировкой | `tracedHttpServer` | Фабрика `serverFactory` для Fastify из `adapter-telemetry`: каждый запрос — серверный спан, родитель — заголовок `traceparent`. |
| Экспорт телеметрии в память | `createMemoryExporters`, `MemoryExporters` | Экспортёры спанов и логов для тестов: записи копятся в массивах и переживают `shutdown`. |
| Ссылка на трейс | `traceUrl`, `traces.urlTemplate` | Функция `ui-core`: адрес трейса в Grafana по `traceId` из шаблона с `{traceId}`. |
| Строка вызова модели | `formatLlmCall` | Функция `ui-core`: строка события `llm.call` в ленте роя — модель, токены с кэшем, стоимость в долларах, статус (спека 002, 4.11). |
| Конфигурация наблюдаемости | `ObservabilityConfig` | `GRAFANA_PORT` в `@swag/config` для `infra:check`. |
| Сборщик телеметрии | OpenTelemetry Collector | Принимает трейсы и логи по OTLP от сервисов и агентов и отправляет в Tempo и Loki. |
| Grafana LGTM | `grafana/otel-lgtm` | Бэкенд наблюдаемости: Loki (логи), Grafana, Tempo (трейсы), позже метрики Prometheus. Локально — один контейнер. |
| Журнал инструментов | `ToolJournal` | Записи `started` / результат по каждому `tool_call_id`. |
| Бюджет | `Budget`, `budgetMicroUsd`, `BudgetMicroUsd`, `spentMicroUsd` | Лимит расходов роя (обязателен) или агента (необязателен) в micro-USD; `spentMicroUsd` — потрачено (004, 4.1, 4.7). |
| Регистрация роя в gateway | `LlmSwarmRegistration`, `LlmSwarmClosed` (в `swarm.ts`), `registerSwarm`, `closeSwarm`, `swarm_agents`, `RegisteredAgent`, `findAgent`, `caller_not_registered` | Внутренний API gateway `/internal/swarms`: бюджет и срок роя, агенты с моделями и бюджетами, закрытие роя; вызов не из регистрации — `403 caller_not_registered` (004, 4.2, 4.5). |
| Ошибка внутреннего API gateway | `InternalErrorCode`, `swarm_registered` | Коды `/internal/*`: `invalid_request`, `model_not_found`, `swarm_registered`, `not_found` (004, 4.2). |
| Бюджеты роёв | `swarm_budgets` | Таблица бюджета, трат и резервов роя в gateway (004, 4.5). |
| Хранилище бюджетов | `BudgetStore`, `RegisteredAgent`, `createPostgresBudgetStore` | Порт `llm-gateway-core` и адаптер Postgres: регистрация, поиск агента, резерв, списание, закрытие, освобождение резервов (004, 4.4, 4.5). |
| Внутренний API gateway | `InternalResult`, `InternalErrorCode`, `internalError` | Результат внутренних операций `registerSwarm` и `closeSwarm` и коды ошибок `invalid_request`, `model_not_found`, `swarm_registered`, `not_found` (004, 4.4). |
| Результат резерва | `ReserveResult`, `reserve`, `settle`, `releaseHolds` | `ReserveResult` — `ok: true` или код `swarm_budget_exceeded` / `agent_budget_exceeded`; `reserve` — условный резерв, `settle` — списание с записью ledger, `releaseHolds` — снятие резервов при старте (004, 4.4, 4.5). |
| Списание вызова | `LlmCharge`, `ChargeBasis`, `charge`, `chargeFor` | Сумма и основание (`usage`, `estimate`, `none`), записанные в ledger и в `llm.call` (004, 4.3). |
| Оценка байтов вызова | `inputBytes`, `outputBytes` | Длина входа и выхода вызова в UTF-8 — верхняя граница токенов для резерва и оценки списания (004, 4.3). |
| Причина «бюджет исчерпан» | `budget_exceeded` | Причина `swarm.failed`: агент получил `402` по бюджету роя или агента (004, 4.6). |
| Отказ вызова до апстрима | `call_refused` | Лог `warn` при отказе `complete` на шагах 2–7 (4.3, 4.4): поле `code` — код ошибки gateway; `swarmId` и `agentId` — только после проверки вызывающего (004, 4.3). Имя на подтверждении, D-92 в `questions.md`. |
| Причина «шлюз недоступен» | `gateway_unavailable` | Причина `swarm.failed`: регистрация роя в gateway не удалась, песочницы не создаются (004, 4.6). |
| Регистрация роёв в оркестраторе | `LlmSwarms`, `createGatewaySwarms`, `@swag/adapter-gateway-http`, `GatewayError` (ошибка ответа внутреннего API, код из тела) | Порт `orchestrator-core` и HTTP-адаптер к внутреннему API gateway (004, 4.6). |
| Сбой закрытия роя в gateway | `gateway_close_failed` | Лог `warn` ядра оркестратора, когда `LlmSwarms.close` бросил исключение; рой всё равно завершается (004, 4.6). |
| Книга цен | `PriceBook` | Порт `llm-gateway-core`: текущие цены модели, которые обновляются из OpenRouter (004, 4.4, 4.9). |
| Старт gateway с Postgres | `startLlmGatewayCore`, `assembleCore` | Оболочка `apps/llm-gateway`: миграции, пул, `BudgetStore`, `PriceStore`, каталог с сохранёнными ценами поверх `models.json`, `PriceBook` и `releaseHolds` до приёма запросов (004, 4.4, 4.9, 4.11, REQ-004-14). |
| Текущий каталог | `CatalogHolder`, `createCatalogHolder` | Оболочка: текущий каталог процесса за `PriceBook`; обновление цен подменяет его целиком (004, 4.9). |
| Цикл обновления цен | `refreshPrices`, `startPriceRefresh`, `price_refresh_failed`, `price_save_failed` | Оболочка `apps/llm-gateway/src/prices.ts`: запрос в OpenRouter, применение, `PriceStore.save`, подмена каталога; первый цикл после сверки, затем по `LLM_PRICES_REFRESH_MS` (004, 4.9). |
| Сохранённые цены | `PriceStore`, `StoredPrice`, `createPostgresPriceStore`, `model_prices`, `applyStoredPrices`, `price_save_failed` | Последние успешные цены OpenRouter в Postgres по id модели OpenRouter; при старте ложатся поверх `models.json` (004, 4.5, 4.9, Q-8). |
| Цены OpenRouter | `applyOpenRouterPrices`, `openRouterModel`, `@swag/adapter-openrouter`, `createOpenRouterPrices`, `OpenRouterPrices`, `price_updated` | Обновление цен каталога из `GET /api/v1/models` OpenRouter (004, 4.9). Адаптер — `createOpenRouterPrices({ url, timeoutMs })` с `fetchModels(signal)`; лог `info` `price_updated` на изменённую модель. |
| Пропуск обновления цены | `price_update_skipped`, `PriceSkip`, `PriceChange` | Лог `warn` оболочки по `skipped` из `applyOpenRouterPrices` (поля `model`, `reason`); `PriceChange` — элемент `changed` с `from` и `to` (004, 4.9). Причины — английский текст, спека его не задаёт. |
| Общие хелперы | `@swag/helpers`, `@swag/helpers/server` | Пакет `packages/helpers`: универсальные функции и хелперы над `fetch` только для сервера. |
| Повтор с задержкой | `retry`, `RetryOptions`, `HttpError`, `httpRetryable`, `parseRetryAfter` | Повтор с экспоненциальной задержкой, полным разбросом и `Retry-After` (004, 4.10). |
| Отчёт сверки | `ledgerReport`, `LedgerReport`, `money:report`, `formatMoneyReport`, `parseMoneyReportArgs` | Суммы ledger по рою или периоду: списано по тарифу, факт провайдера, разница (004, 4.5, 4.13). `formatMoneyReport` — строки отчёта, `parseMoneyReportArgs` — разбор `--swarm` и `--since` в `scripts/money-report.ts`. |
| Деньги в UI | `formatUsd`, `usdToMicro`, `spentLastMinute`, `formatSwarmMoney` | Функции `ui-core`: сумма, перевод из долларов, расход за минуту, строка панели роя (004, 4.8). |
| Ввод денег формы | `AgentInput`, `agentBudgetMicro`, `swarmFormInput` | `ui-core`: поля формы роя в доллары → micro-USD; пустой бюджет агента — `null` (004, 4.8). |
| Тексты причин роя | `failureReasonText` | `ui-core`: текст причины `swarm.failed` — `budget_exceeded`, `gateway_unavailable` из 4.8, прочие как пришли (004, 4.8). |
| Таймер строки денег | `MONEY_TICK_MS` | Константа cabinet: строка денег и «за минуту» обновляются раз в 5 с (004, 4.8). |
| Пределы и цены в env | `SWARM_MAX_BUDGET_MICRO_USD` (поле `ApiCoreDeps.limits.maxBudgetMicroUsd`), `LLM_PRICES_REFRESH_MS`, `OPENROUTER_MODELS_URL` | Предел бюджета роя в `api`; период и источник цен в gateway (004, 4.11). |
| Деньги в micro-USD | `MicroUsd` | Схема целой суммы ≥ 0 в micro-USD (004, 4.1). |
| Reaper | `Reaper` | Фоновая уборка ресурсов роя по TTL. |
| Eval-задача | `EvalCase` | Эталонная задача с ожидаемым результатом и потолком стоимости. |
| Ядро | `packages/<имя>-core`, `create<Имя>Core` | Вся логика сервиса или приложения на чистом TypeScript, без фреймворков и инфраструктуры. См. [архитектуру](../architecture.md). |
| Оболочка | `apps/<имя>` | Тонкий слой, подключающий ядро к способу входа: Fastify, процесс агента в песочнице, UI. |
| Порт | интерфейс в ядре, например `SandboxProvider`, `Clock` | То, что ядру нужно от внешнего мира, описанное интерфейсом. |
| Адаптер | `packages/adapter-<технология>` | Реализация порта на конкретной технологии (Docker, Postgres, NATS, S3, LiteLLM). |
| Порт шины агента | `AgentBus` | Порт `agent-core`: подписка на inbox с обработчиком-`Promise` (адаптер сериализует сообщения, 022 REQ-022-14), публикация событий и сообщений роя. Реализация — поверх `adapter-nats`. |
| Порт потока роя | `EventStream` | Порт `ui-core`: открыть поток событий роя с `after`, получить события, закрыть. Реализация — WebSocket в `apps/ui/cabinet`. |
| Порт API роёв | `SwarmsApi` | Порт `ui-core`: REST-операции роёв (список, создание, состояние, остановка). |
| Страница роя | `SwarmPage` | Состояние экрана роя в `ui-core`: `view` и `feed` из событий, переподключение, остановка. |
| Ядро UI | `createUiCore`, `UiCore` | Логика фронтендов платформы (`packages/ui-core`): валидация формы, страница роя, переподключение. |
| Шина NATS | `NatsBus` | Адаптер шины `adapter-nats`: JSON-публикация и подписка по subjects. |
| Конфигурация агента | `AgentConfig` | Env агента (022, 4.8) в `@swag/config`; без `DATABASE_URL`. |
| Модель агента | `AGENT_MODEL` | Имя модели из плана роя (`PlatformModel`), env агента (022, 4.8). |
| Лимиты агента | `AGENT_MAX_STEPS`, `AGENT_MAX_TOKENS`, `AGENT_LLM_TIMEOUT_MS`, `AGENT_LLM_MAX_RETRIES` | Лимиты цикла и вызова модели агента; первые два задаёт оркестратор, два последних — умолчания `AgentConfig` (022, 4.8). |
| Лимит ответа агента | `maxTokens`, `MaxTokens`, `AGENT_MAX_TOKENS_LIMIT`, `maxTokensInput` | `max_tokens` вызовов агента, заданный на рой или агента при создании роя; `null` — значение уровня выше, в конце `AGENT_MAX_TOKENS` оркестратора; предел — `AGENT_MAX_TOKENS_LIMIT` в `api` (031, 4.1–4.5). |
| Шлюз моделей для агента | `LLM_GATEWAY_URL`, `DOCKER_AGENT_LLM_GATEWAY_URL` | Адрес gateway изнутри песочницы (022) и для оркестратора (004, 4.11); агенты ходят с общим `LLM_GATEWAY_TOKEN` (004, Q-2). |
| Конфигурация UI | `UiConfig` | Порт `UI_PORT` для проверки инфраструктуры в `@swag/config`. |
| Команда пинга шлюза | `llm:ping`, `scripts/llm-ping.ts` | Ручная проверка с хоста: один вызов `POST /v1/chat/completions` через gateway, печатает ответ, `usage`, задержку (спека 002, 4.13, REQ-002-17). |
| Конфигурация шлюза | `LlmGatewayConfig` | Env `llm-gateway` (002, 4.9) в `@swag/config`: телеметрия, ключи из `.env.llm`; без `DATABASE_URL`. |
| Старт шлюза | `startGateway`, `waitForUpstream` | Старт оболочки `apps/llm-gateway`: сверка каталога с апстримом с повтором раз в 1 с до `LLM_GATEWAY_STARTUP_TIMEOUT_MS`; порт слушается только после успеха, иначе выход с кодом 1 (002, REQ-002-13). |
| Ошибка старта: апстрим недоступен | `upstream_unavailable` | Лог `error` при старте шлюза, когда апстрим не ответил до дедлайна; поле `reason` = `failure.kind` (002, D-64). |
| Ошибка старта: нет моделей | `upstream_models_mismatch` | Лог `error` при старте шлюза, когда в апстриме нет моделей каталога; поле `missing` — их id (002, REQ-002-13, AC-002-18). |
| Секреты апстрима | `upstreamSecrets` | Значения, которые адаптер LiteLLM заменяет на `***`: мастер-ключ и непустые `*_API_KEY` из env (002, 4.9). |
| Каталог моделей (файл) | `readCatalog` | Чтение `infra/llm/<профиль>/models.json` по `LLM_CATALOG_PATH` и проверка схемой `ModelCatalog` в оболочке шлюза (002, 4.7). |
| Опции Fastify телеметрии | `telemetryAppOptions` | Опции Fastify оболочки `apps/llm-gateway`: логгер телеметрии и серверный спан на запрос, кроме `/health`; общие для `main.ts` и тестов (002, 4.10, REQ-002-14). |
