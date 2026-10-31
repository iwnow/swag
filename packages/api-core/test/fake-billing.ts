import type { Billing } from '../src/index.ts';

export interface FakeBilling extends Billing {
  reserves: { orgId: string; swarmId: string; amountMicroUsd: number }[];
  settles: { swarmId: string; spentMicroUsd: number }[];
  reserveResult: 'ok' | 'insufficient' | Error;
  settleError: Error | null;
  held: { swarmId: string; orgId: string; amountMicroUsd: number }[];
}

// Безлимитный баланс: reserve всегда ok, пока тест не задаст иное; все вызовы записываются.
export function fakeBilling(): FakeBilling {
  const fake: FakeBilling = {
    reserves: [],
    settles: [],
    reserveResult: 'ok',
    settleError: null,
    held: [],
    async reserve(orgId, swarmId, amountMicroUsd) {
      fake.reserves.push({ orgId, swarmId, amountMicroUsd });
      if (fake.reserveResult instanceof Error) throw fake.reserveResult;
      return fake.reserveResult;
    },
    async settle(swarmId, spentMicroUsd) {
      fake.settles.push({ swarmId, spentMicroUsd });
      if (fake.settleError) throw fake.settleError;
    },
    async holds() {
      return [...fake.held];
    },
  };
  return fake;
}
