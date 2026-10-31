import { describe, expect, it, vi } from 'vitest';
import { createLlmGatewayCore, type LedgerEntry } from '../src/index.ts';
import { fakeDeps, TEST_SWARM_ID } from './fakes.ts';

// Спека 013, 4.7 и NFR-013-2: закрытие роя ждёт списания идущих вызовов; часы и sleep — тестовые.

const CALL_ID = '3d9b7f1a-2c4e-4a6b-8d0f-1e2f3a4b5c6d';
const caller = { swarmId: TEST_SWARM_ID, agentId: 'agent-1' };
const settledEntry: LedgerEntry = {
  callId: CALL_ID,
  ts: '2026-10-27T10:00:00.300Z',
  swarmId: TEST_SWARM_ID,
  agentId: 'agent-1',
  model: 'chat-small',
  kind: 'llm',
  amountMicroUsd: 700,
  basis: 'usage',
  providerCostMicroUsd: null,
};

describe('closeSwarm ждёт идущие вызовы', () => {
  it('AC-013-18: списание идущего вызова пришло через 300 мс — ответ после списания, heldMicroUsd 0, spentMicroUsd включает вызов', async () => {
    const { deps, clock, budgets } = fakeDeps();
    await budgets.reserve(CALL_ID, caller, 1000, clock.now());
    const sleep = vi.fn(async (ms: number) => {
      clock.advance(ms);
      if (clock.monotonicMs() >= 300 && budgets.holdCallIds().includes(CALL_ID)) {
        await budgets.settle(settledEntry);
      }
    });

    const result = await createLlmGatewayCore({ ...deps, sleep }).closeSwarm(TEST_SWARM_ID);

    expect(result).toEqual({ ok: true, value: { spentMicroUsd: 700, heldMicroUsd: 0 } });
    expect(sleep).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledWith(100);
  });

  it('AC-013-18: списание не пришло за closeWaitMs — ответ с heldMicroUsd > 0 и лог warn close_holds_pending', async () => {
    const { deps, clock, budgets, log } = fakeDeps();
    await budgets.reserve(CALL_ID, caller, 1000, clock.now());
    const sleep = vi.fn(async (ms: number) => {
      clock.advance(ms);
    });

    const result = await createLlmGatewayCore({ ...deps, sleep, closeWaitMs: 1000 }).closeSwarm(
      TEST_SWARM_ID,
    );

    expect(result).toEqual({ ok: true, value: { spentMicroUsd: 0, heldMicroUsd: 1000 } });
    expect(sleep).toHaveBeenCalledTimes(10);
    expect(log.entries).toContainEqual({
      level: 'warn',
      msg: 'close_holds_pending',
      ctx: { swarmId: TEST_SWARM_ID, heldMicroUsd: 1000 },
    });
  });

  it('AC-013-18: при heldMicroUsd 0 после close ни одного sleep и лога close_holds_pending (NFR-013-2)', async () => {
    const { deps, log } = fakeDeps();
    const sleep = vi.fn(async () => {});

    const result = await createLlmGatewayCore({ ...deps, sleep }).closeSwarm(TEST_SWARM_ID);

    expect(result).toEqual({ ok: true, value: { spentMicroUsd: 0, heldMicroUsd: 0 } });
    expect(sleep).not.toHaveBeenCalled();
    expect(log.entries.some((entry) => entry.msg === 'close_holds_pending')).toBe(false);
  });

  it('AC-013-18: повторный closeSwarm отдаёт тот же spentMicroUsd', async () => {
    const { deps, budgets, clock } = fakeDeps();
    await budgets.reserve(CALL_ID, caller, 1000, clock.now());
    await budgets.settle(settledEntry);
    const core = createLlmGatewayCore(deps);

    const first = await core.closeSwarm(TEST_SWARM_ID);
    const again = await core.closeSwarm(TEST_SWARM_ID);

    expect(first).toEqual({ ok: true, value: { spentMicroUsd: 700, heldMicroUsd: 0 } });
    expect(again).toEqual(first);
  });
});
