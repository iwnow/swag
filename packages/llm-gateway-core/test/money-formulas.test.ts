import { describe, expect, it } from 'vitest';
import { chargeFor, holdMicroUsd, inputBytes, outputBytes } from '../src/index.ts';

// Спека 004, 4.3 (таблицы примеров и формулы резерва/списания). Чистые функции без апстрима и шины.

const PRICES = {
  inputPerMTokUsd: '3.00',
  cachedInputPerMTokUsd: '0.30',
  outputPerMTokUsd: '15.00',
};
const FREE = { inputPerMTokUsd: '0', cachedInputPerMTokUsd: '0', outputPerMTokUsd: '0' };

describe('AC-004-9: holdMicroUsd по таблице 4.3', () => {
  it.each([
    ['inputBytes 1000, max_tokens 500', 1000, 500, PRICES, 10500],
    ['inputBytes 1, max_tokens 1, цены 0 / 0 / 0', 1, 1, FREE, 0],
  ])('AC-004-9: %s → %i', (_, bytesIn, maxOut, prices, expected) => {
    expect(holdMicroUsd(bytesIn, maxOut, prices)).toBe(expected);
  });
});

describe('AC-004-9: chargeFor по таблице 4.3', () => {
  it.each([
    [
      'usage 1000 / 200 / 500, status ok',
      {
        status: 'ok' as const,
        usage: { promptTokens: 1000, cachedPromptTokens: 200, completionTokens: 500 },
        inputBytes: 0,
        outputBytes: 0,
      },
      { microUsd: 9960, basis: 'usage' },
    ],
    [
      'нет usage, inputBytes 1000, outputBytes 100, aborted',
      { status: 'aborted' as const, usage: null, inputBytes: 1000, outputBytes: 100 },
      { microUsd: 4500, basis: 'estimate' },
    ],
    [
      'нет usage, status ok, inputBytes 10, outputBytes 0',
      { status: 'ok' as const, usage: null, inputBytes: 10, outputBytes: 0 },
      { microUsd: 30, basis: 'estimate' },
    ],
    [
      'status error',
      { status: 'error' as const, usage: null, inputBytes: 1000, outputBytes: 100 },
      { microUsd: 0, basis: 'none' },
    ],
  ])('AC-004-9: %s', (_, call, expected) => {
    expect(chargeFor(call, PRICES)).toEqual(expected);
  });

  it('AC-004-9: usage есть при status aborted — по usage, не по оценке', () => {
    const usage = { promptTokens: 1000, cachedPromptTokens: 200, completionTokens: 500 };
    expect(
      chargeFor({ status: 'aborted', usage, inputBytes: 1000, outputBytes: 100 }, PRICES),
    ).toEqual({
      microUsd: 9960,
      basis: 'usage',
    });
  });
});

describe('AC-004-9: inputBytes и outputBytes — UTF-8', () => {
  const withContent = (content: string) =>
    ({ messages: [{ role: 'user', content }] }) as Parameters<typeof inputBytes>[0];

  it('AC-004-9: "ё" на 1 байт больше, чем "e" (2 байта против 1)', () => {
    expect(inputBytes(withContent('ё'))).toBe(inputBytes(withContent('e')) + 1);
  });

  it('AC-004-9: inputBytes считает JSON строки с messages и tools по умолчанию []', () => {
    const body = { messages: [{ role: 'user', content: 'a' }] } as Parameters<typeof inputBytes>[0];
    expect(inputBytes(body)).toBe(
      new TextEncoder().encode(JSON.stringify({ messages: body.messages, tools: [] })).length,
    );
  });

  it('AC-004-9: outputBytes суммирует content и tool_calls[].function.arguments в UTF-8', () => {
    expect(outputBytes({ role: 'assistant', content: 'ёж' })).toBe(4);
    expect(
      outputBytes({
        content: 'a',
        tool_calls: [{ function: { name: 'lookup', arguments: '{"q":"ё"}' } }],
      }),
    ).toBe(11); // 'a' — 1 байт, аргументы '{"q":"ё"}' — 10 байт (ё — 2)
    expect(outputBytes({ delta: {} })).toBe(0);
  });
});
