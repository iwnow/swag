import { describe, expect, it } from 'vitest';
import { formatAgentStep, type AgentStepData } from '../src/index.ts';

const base: AgentStepData = {
  messageId: '0b6f6d2e-6a4c-4c3e-9f5e-333333333333',
  stepIndex: 2,
  text: null,
  toolCalls: [],
};

describe('formatAgentStep', () => {
  it.each<[string, AgentStepData, string]>([
    ['AC-022-23: только текст', { ...base, text: 'Передаю редактору' }, 'шаг 2: Передаю редактору'],
    [
      'AC-022-23: только инструменты',
      { ...base, toolCalls: [{ id: 'call_0', name: 'send_message' }] },
      'шаг 2 → send_message',
    ],
    [
      'AC-022-23: текст и инструменты',
      {
        ...base,
        text: 'Передаю редактору',
        toolCalls: [
          { id: 'call_0', name: 'send_message' },
          { id: 'call_1', name: 'finish' },
        ],
      },
      'шаг 2: Передаю редактору → send_message, finish',
    ],
  ])('%s', (_name, data, expected) => {
    expect(formatAgentStep(data)).toBe(expected);
  });
});
