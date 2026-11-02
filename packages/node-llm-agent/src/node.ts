import { AgentDraft } from '@swag/contracts';
import { defineNode } from '@swag/node-sdk';

// Спека 021, 4.4: настройки — тот же AgentDraft, что у SwarmCreateRequest (REQ-021-10).
export default defineNode({
  type: 'swag/llm-agent',
  version: '1.0.0',
  kind: 'llm-agent',
  title: 'LLM-агент',
  description:
    'Агент на модели платформы: роль, модель, бюджет и лимит ответа. Исполняется агентным циклом платформы.',
  settings: AgentDraft,
});
