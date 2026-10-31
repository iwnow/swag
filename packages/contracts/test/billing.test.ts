import { describe, expect, it } from 'vitest';
import { TopupMicroUsd, TopupRequest, BalanceEntry } from '../src/index.ts';

const ORG_ID = '0b6f6d2e-6a4c-4c3e-9f5e-222222222222';
const USER_ID = '0b6f6d2e-6a4c-4c3e-9f5e-111111111111';

describe('схемы баланса', () => {
  it('TopupMicroUsd — границы 1 и 1 000 000 000 проходят, 0 и 1 000 000 001 отвергаются, дробное отвергается', () => {
    expect(TopupMicroUsd.safeParse(1).success).toBe(true);
    expect(TopupMicroUsd.safeParse(1_000_000_000).success).toBe(true);
    expect(TopupMicroUsd.safeParse(0).success).toBe(false);
    expect(TopupMicroUsd.safeParse(1_000_000_001).success).toBe(false);
    expect(TopupMicroUsd.safeParse(1.5).success).toBe(false);
  });

  it('TopupRequest без comment получает null', () => {
    expect(TopupRequest.parse({ amountMicroUsd: 500 })).toEqual({
      amountMicroUsd: 500,
      comment: null,
    });
  });

  it('TopupRequest отвергает пустую строку comment и лишние поля', () => {
    expect(TopupRequest.safeParse({ amountMicroUsd: 500, comment: '' }).success).toBe(false);
    expect(TopupRequest.safeParse({ amountMicroUsd: 500, comment: '   ' }).success).toBe(false);
    expect(TopupRequest.safeParse({ amountMicroUsd: 500, extra: 1 }).success).toBe(false);
  });

  it('BalanceEntry — topup с actorId проходит, swarm с swarmId и actorId null проходит', () => {
    const base = { id: 1, orgId: ORG_ID, ts: '2026-11-01T10:00:00.000Z', comment: null };
    expect(
      BalanceEntry.safeParse({
        ...base,
        kind: 'topup',
        amountMicroUsd: 100,
        swarmId: null,
        actorId: USER_ID,
      }).success,
    ).toBe(true);
    expect(
      BalanceEntry.safeParse({
        ...base,
        kind: 'swarm',
        amountMicroUsd: -100,
        swarmId: USER_ID,
        actorId: null,
      }).success,
    ).toBe(true);
  });
});
