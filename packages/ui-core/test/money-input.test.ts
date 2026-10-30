import { describe, expect, it } from 'vitest';
import { SwarmCreateRequest } from '@swag/contracts';
import {
  agentBudgetMicro,
  createUiCore,
  failureReasonText,
  swarmFormInput,
  type EventStream,
  type SwarmsApi,
  type Timers,
} from '../src/index.ts';

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
    const input = swarmFormInput('задача', '0.50', '', [{ ...agent, budget: '', maxTokens: '' }]);
    expect(input).toEqual({
      task: 'задача',
      budgetMicroUsd: 500000,
      maxTokens: null,
      agents: [{ ...agent, budgetMicroUsd: null, maxTokens: null }],
    });
    expect(SwarmCreateRequest.safeParse(input).success).toBe(true);
  });

  it('некорректный бюджет роя не проходит SwarmCreateRequest', () => {
    const input = swarmFormInput('задача', '', '', [{ ...agent, budget: '', maxTokens: '' }]);
    expect(SwarmCreateRequest.safeParse(input).success).toBe(false);
  });

  it('AC-031-5: пустой лимит роя — null, лимит агента 16384 и пустой — null; лимит abc даёт NaN и ошибку validateForm', () => {
    const input = swarmFormInput('задача', '0.50', '', [
      { ...agent, budget: '', maxTokens: '16384' },
      { ...agent, budget: '', maxTokens: '' },
    ]);
    expect(input).toMatchObject({
      maxTokens: null,
      agents: [{ maxTokens: 16384 }, { maxTokens: null }],
    });
    expect(SwarmCreateRequest.safeParse(input).success).toBe(true);

    const invalid = swarmFormInput('задача', '0.50', 'abc', [
      { ...agent, budget: '', maxTokens: '' },
    ]);
    expect(invalid).toMatchObject({ maxTokens: NaN });
    const core = createUiCore({
      api: {} as SwarmsApi,
      stream: {} as EventStream,
      timers: {} as Timers,
      traces: { urlTemplate: '' },
    });
    const result = core.validateForm(invalid);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues.map((issue) => issue.path)).toContain('maxTokens');
  });
});
