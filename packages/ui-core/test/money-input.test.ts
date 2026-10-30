import { describe, expect, it } from 'vitest';
import { SwarmCreateRequest } from '@swag/contracts';
import { agentBudgetMicro, failureReasonText, swarmFormInput } from '../src/index.ts';

// Спека 004, 4.8: перевод полей формы в micro-USD и тексты причин.

describe('agentBudgetMicro', () => {
  it('пустое поле — бюджета нет (null)', () => {
    expect(agentBudgetMicro('')).toBeNull();
    expect(agentBudgetMicro('   ')).toBeNull();
  });

  it('доллары переводятся через usdToMicro', () => {
    expect(agentBudgetMicro('0.25')).toBe(250000);
    expect(agentBudgetMicro('1')).toBe(1000000);
  });

  it('некорректный ввод даёт NaN, который отсекает SwarmCreateRequest', () => {
    expect(agentBudgetMicro('abc')).toBeNaN();
  });
});

describe('failureReasonText', () => {
  it('budget_exceeded и gateway_unavailable — тексты 4.8', () => {
    expect(failureReasonText('budget_exceeded')).toBe('бюджет исчерпан');
    expect(failureReasonText('gateway_unavailable')).toBe('шлюз моделей недоступен');
  });

  it('прочие причины выводятся как пришли', () => {
    expect(failureReasonText('model_error')).toBe('model_error');
  });
});

describe('swarmFormInput', () => {
  const agent = { name: 'Ив', role: 'роль', model: 'chat-small' as const };

  it('бюджет роя по умолчанию $0.50 и пустой бюджет агента проходят SwarmCreateRequest', () => {
    const input = swarmFormInput('задача', '0.50', [{ ...agent, budget: '' }]);
    expect(input).toEqual({
      task: 'задача',
      budgetMicroUsd: 500000,
      agents: [{ ...agent, budgetMicroUsd: null }],
    });
    expect(SwarmCreateRequest.safeParse(input).success).toBe(true);
  });

  it('некорректный бюджет роя не проходит SwarmCreateRequest', () => {
    const input = swarmFormInput('задача', '', [{ ...agent, budget: '' }]);
    expect(SwarmCreateRequest.safeParse(input).success).toBe(false);
  });
});
