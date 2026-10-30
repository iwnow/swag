import type { PlatformModel } from '@swag/contracts';
import { usdToMicro } from '@swag/ui-core';

// Спека 004, 4.8: перевод входа формы (доллары строками) в поля SwarmCreateRequest. Логика — в ui-core.

export interface AgentInput {
  name: string;
  role: string;
  model: PlatformModel;
  budget: string; // «Бюджет агента, $»: пустое — бюджета нет
}

export function agentBudgetMicro(budget: string): number | null {
  return budget.trim() === '' ? null : usdToMicro(budget);
}

export function swarmFormInput(task: string, budget: string, agents: AgentInput[]): unknown {
  return {
    task,
    budgetMicroUsd: usdToMicro(budget),
    agents: agents.map(({ budget: agentBudget, ...agent }) => ({
      ...agent,
      budgetMicroUsd: agentBudgetMicro(agentBudget),
    })),
  };
}

// Спека 004, 4.8: тексты причин swarm.failed; остальные причины выводятся как пришли.
const FAILURE_REASON_TEXT: Record<string, string> = {
  budget_exceeded: 'бюджет исчерпан',
  gateway_unavailable: 'шлюз моделей недоступен',
};

export function failureReasonText(reason: string): string {
  return FAILURE_REASON_TEXT[reason] ?? reason;
}
