---
id: "032"
title: Профиль моделей test-pay
status: draft
roadmap_stage: 4
depends_on: ["002", "004"]
superseded_by: null
updated: 2026-10-30
---

# 032. Профиль моделей test-pay

> **Коротко.**
>
> - **Что появится.** Четвёртый профиль `LLM_PROFILE=test-pay`: OpenRouter, самые дешёвые платные модели с `tools` и без reasoning. Платные проверки денег и роёв идут на нём, а не на `prod`.
> - **Модели.** `chat-small` — `mistralai/mistral-nemo` ($0.029 / $0.03 за 1 млн токенов), `chat-large` — `meta-llama/llama-3.1-8b-instruct` ($0.05 / $0.08) (Q-1).
> - **Что не меняется.** `prod` остаётся на DeepSeek, `dev` — на бесплатных моделях, `test` — на фейковом провайдере. Код gateway не меняется: цены `test-pay` обновляются из OpenRouter так же, как у `dev` и `prod`.
> - **Что нужно от человека.** Q-1 и Q-2 решены 2026-10-30 по рекомендации; осталось поставить `ready`.

## 1. Контекст и цель

Роадмап, этап 4 «Деньги роя»: сверка расходов с провайдером. Решение человека от 2026-10-30: `prod` с `deepseek-v4-flash` не использовать для тестов, нужен отдельный профиль с дешёвой платной моделью. Это тот же профиль, что сценарий S-2 называл `dev-paid` (шаг 3), и вариант (г) из D-111.

Сейчас профилей три (`test`, `dev`, `prod`), их список зашит в `LlmGatewayConfig.LLM_PROFILE`, в `apps/llm-gateway/src/prices.ts` и в `scripts/repo.test.ts`. Платную проверку AC-004-36 пришлось делать на `prod`; у бесплатных моделей `dev` всегда есть reasoning, и он съедает `max_tokens` (D-111).

После спеки `LLM_PROFILE=test-pay npm run up` поднимает контур на платных моделях без reasoning ценой в доли цента за рой.

## 2. Объём

**Входит:**

- каталог `infra/llm/test-pay/` (`litellm.yaml`, `models.json`);
- значение `test-pay` в `LLM_PROFILE` и в типе профиля `prices.ts`;
- проверки каталогов в `scripts/repo.test.ts` на четыре профиля;
- тексты: спека 002 (REQ-002-12, 4.7), глоссарий, README `llm-gateway`, корневой README, S-2.

**Не входит** (агент это не делает, даже если кажется логичным):

- смена моделей `prod` и `dev`;
- выключение reasoning через параметры LiteLLM — D-111;
- переключение профиля на поднятом контуре без перезапуска (S-2, «способ переключить профиль»);
- баланс ИИ и сценарий S-2 целиком — спеки 013, 025;
- автоматический выбор самой дешёвой модели из каталога OpenRouter.

## 3. Требования

| ID | Требование | Приоритет |
|---|---|---|
| REQ-032-1 | `LLM_PROFILE` MUST принимать `test-pay`; каталог `infra/llm/test-pay/` MUST проходить те же проверки, что `dev` и `prod`: `ModelCatalog`, те же `id`, каждый `id` — `model_name` в `litellm.yaml`, `openRouterModel` равен модели LiteLLM без `openrouter/`. | MUST |
| REQ-032-2 | Модели `test-pay` MUST быть платными моделями OpenRouter с `tools` и без `reasoning` в `supported_parameters` (Q-1). | MUST |
| REQ-032-3 | Gateway на `test-pay` MUST обновлять цены из OpenRouter так же, как на `dev` и `prod`. | MUST |
| REQ-032-4 | Рой из двух агентов на `test-pay` MUST доходить до `swarm.completed` без `model_error:max_tokens` при `AGENT_MAX_TOKENS=8192`. | MUST |

## 4. Контракты

### 4.1. Env

`packages/config/src/index.ts`, `LlmGatewayConfig`:

```ts
LLM_PROFILE: z.enum(['test', 'dev', 'test-pay', 'prod']), // спека 002, 4.8; 032; test не обращается к OpenRouter (004, 4.9)
```

`apps/llm-gateway/src/prices.ts`: `profile: 'test' | 'dev' | 'test-pay' | 'prod'`. Условие «`test` не ходит в OpenRouter» не меняется.

Ключ — `OPENROUTER_API_KEY` из `.env.llm`, как у `dev` и `prod`.

### 4.2. `infra/llm/test-pay/litellm.yaml`

```yaml
# Профиль test-pay (спека 032): OpenRouter, дешёвые платные модели без reasoning для платных проверок. Ключ — из окружения.
model_list:
  - model_name: chat-small
    litellm_params:
      model: openrouter/mistralai/mistral-nemo
      api_key: os.environ/OPENROUTER_API_KEY
  - model_name: chat-large
    litellm_params:
      model: openrouter/meta-llama/llama-3.1-8b-instruct
      api_key: os.environ/OPENROUTER_API_KEY
general_settings:
  master_key: os.environ/LITELLM_MASTER_KEY
```

### 4.3. `infra/llm/test-pay/models.json`

Формат 002, 4.1 и 004 (`openRouterModel`). Цены — OpenRouter на 2026-10-30, gateway обновляет их при старте:

| `id` | `openRouterModel` | `inputPerMTokUsd` | `cachedInputPerMTokUsd` | `outputPerMTokUsd` |
|---|---|---|---|---|
| `chat-small` | `mistralai/mistral-nemo` | `0.029` | `0.029` | `0.03` |
| `chat-large` | `meta-llama/llama-3.1-8b-instruct` | `0.05` | `0.05` | `0.08` |

Кэша промпта у этих моделей в OpenRouter нет: `cachedInputPerMTokUsd` равен цене входа.

### 4.4. `scripts/repo.test.ts`

`profiles = ['test', 'dev', 'test-pay', 'prod']`; проверка AC-004-30 — по `['dev', 'test-pay', 'prod']`.

## 5. Критерии приёмки

- **AC-032-1** — *Given* каталоги `infra/llm/*`. *When* `scripts/repo.test.ts`. *Then* `test-pay` проходит `ModelCatalog`, его `id` равны `id` остальных профилей, каждый `id` есть в `litellm.yaml`, `openRouterModel` равен модели LiteLLM без `openrouter/`. Тест: `scripts/repo.test.ts`.
- **AC-032-2** — *Given* `LLM_PROFILE=test-pay` в окружении. *When* разбор `LlmGatewayConfig`. *Then* профиль принят; `LLM_PROFILE=dev-paid` отклоняется. Тест: `packages/config/test/config.test.ts`.
- **AC-032-3** `[manual]` — *Given* `GET https://openrouter.ai/api/v1/models`. *When* поиск моделей `test-pay`. *Then* у обеих цена больше 0, в `supported_parameters` есть `tools` и нет `reasoning`. Проверка: вывод скрипта-запроса в журнал.
- **AC-032-4** `[manual]` — *Given* `LLM_PROFILE=test-pay npm run up`, ключ в `.env.llm`. *When* `npm run llm:ping`, затем рой из двух агентов `chat-small` с задачей из S-3. *Then* в логе gateway цены обновлены из OpenRouter, `llm.call` со стоимостью больше 0, рой `swarm.completed`, ни одного `model_error:max_tokens`; итог роя в долях цента. Проверка: строки лога, итоговая стоимость роя и разница кредитов OpenRouter — в журнал.

## 6. Нефункциональные требования

| ID | Требование | Как измеряется |
|---|---|---|
| NFR-032-1 | Рой AC-032-4 стоит меньше $0.01. | `spentMicroUsd` роя и разница `GET /api/v1/credits` до и после, в журнал |

## 7. Безопасность: что не должно сломаться

- `test` по-прежнему не обращается к OpenRouter → тесты `prices.ts` спеки 004 (AC-004-30 и соседние) не меняются.
- `prod` и `dev` не меняются → AC-032-1 сверяет их каталоги как раньше.
- Ключ OpenRouter не попадает в репозиторий и в песочницу: `litellm.yaml` берёт его из окружения → AC-032-1 (файл без значений ключей).

## 8. Задачи для агента

- [ ] **T-1.** Каталог `infra/llm/test-pay/` по 4.2–4.3; `scripts/repo.test.ts` по 4.4. Закрывает: REQ-032-1, AC-032-1. Готово, когда: `npx vitest run scripts/repo.test.ts` зелёный.
- [ ] **T-2.** `packages/config/src/index.ts` и `apps/llm-gateway/src/prices.ts` по 4.1; тест AC-032-2 в `packages/config/test/config.test.ts`; комментарий профилей в `compose.yaml` (`test, dev, test-pay, prod`); README `config` и `llm-gateway` (раздел «Профили моделей»), корневой README (профили). Закрывает: REQ-032-1, REQ-032-3, AC-032-2. Готово, когда: `npm run check` зелёный.
- [ ] **T-3.** Тексты: спека 002 — REQ-002-12 и раздел 4.7 перечисляют `test-pay` (пометка «изменено спекой 032»), строка в журнале 002; глоссарий «Профиль моделей» уже исправлен; S-2 шаг 3 — профиль `test-pay`. Закрывает: — . Готово, когда: `npm run spec:check` зелёный.
- [ ] **T-4.** Ручные проверки AC-032-3 и AC-032-4, замер NFR-032-1, результаты в журнал. Закрывает: REQ-032-2, REQ-032-4, AC-032-3, AC-032-4, NFR-032-1. Готово, когда: результаты в журнале.

## 9. Открытые вопросы

Все вопросы решены.

- [x] **Q-1.** Модели `test-pay`. Самые дешёвые платные модели OpenRouter с `tools` на 2026-10-30, $ за 1 млн токенов (вход / выход):
  - `mistralai/mistral-nemo` — 0.029 / 0.03, без reasoning;
  - `meta-llama/llama-3.1-8b-instruct` — 0.05 / 0.08, без reasoning;
  - `amazon/nova-micro-v1` — 0.035 / 0.14, без reasoning;
  - `openai/gpt-oss-20b` — 0.018 / 0.09, с reasoning;
  - `deepseek/deepseek-v4-flash` — 0.091 / 0.182, с reasoning (сейчас в `prod`).

  (а) `chat-small` — `mistral-nemo`, `chat-large` — `llama-3.1-8b-instruct`. (б) Обе — `mistral-nemo`. (в) `chat-large` — `nova-micro-v1`. **Рекомендация: (а)** — самые дешёвые без reasoning, и `chat-large` остаётся другой моделью, так что выбор модели в форме проверяется по-настоящему. Риск: малые модели хуже вызывают инструменты; если AC-032-4 не пройдёт, следующий кандидат на `chat-small` — `nova-micro-v1`. *(Claude, 2026-10-30)* **Ответ (человек, 2026-10-30):** (а).
- [x] **Q-2.** Платные ручные проверки после спеки. (а) Все будущие платные проверки (как AC-004-36) идут на `test-pay`, `prod` — только для приёмки перед выпуском. (б) Решать в каждой спеке. **Рекомендация: (а)** — так требует решение человека «не тестировать на `prod`», и правило не придётся повторять в каждой спеке. Правило записывается в README спек, раздел о ручных проверках. *(Claude, 2026-10-30)* **Ответ (человек, 2026-10-30):** (а).

## 10. Журнал реализации

Заполняет агент.

| Дата | Ветка / коммит | Что сделано | Отклонения от спеки |
|---|---|---|---|
