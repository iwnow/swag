import type { LlmSwarmRegistration } from '@swag/contracts';
import { describe, expect, it, vi } from 'vitest';
import { createLlmGatewayCore } from '../src/index.ts';
import { fakeDeps, TEST_SWARM_ID } from './fakes.ts';

// Спека 004, 4.2 и 4.4: регистрация роя, проверка вызывающего, закрытие роя.

const signal = { aborted: false };
const OTHER_SWARM_ID = '0b9e1c2d-3f4a-4b5c-8d6e-7f8091a2b3c4';
const body = {
  model: 'chat-small',
  messages: [{ role: 'user', content: 'привет' }],
  max_tokens: 256,
};
const OK = {
  ok: true,
  body: { choices: [], usage: { prompt_tokens: 1, completion_tokens: 1 } },
} as const;

const TWO_AGENTS: LlmSwarmRegistration = {
  swarmId: TEST_SWARM_ID,
  budgetMicroUsd: 1_000_000_000,
  expiresAt: null,
  agents: [
    { agentId: 'agent-1', model: 'chat-small', budgetMicroUsd: null },
    { agentId: 'agent-2', model: 'chat-large', budgetMicroUsd: null },
  ],
};

describe('registerSwarm и closeSwarm', () => {
  it('AC-004-4: регистрация с двумя агентами — ok, register получил рой, срок и агентов', async () => {
    const { deps, budgets } = fakeDeps({ registered: false });
    const register = vi.spyOn(budgets, 'register');
    expect(await createLlmGatewayCore(deps).registerSwarm(TWO_AGENTS)).toEqual({
      ok: true,
      value: undefined,
    });
    expect(register).toHaveBeenCalledWith(TWO_AGENTS, expect.any(Date));
  });

  it('AC-004-4: повтор с тем же swarmId — 409 swarm_registered', async () => {
    const { deps, budgets } = fakeDeps({ registered: false });
    const core = createLlmGatewayCore(deps);
    await core.registerSwarm(TWO_AGENTS);
    const register = vi.spyOn(budgets, 'register');
    expect(await core.registerSwarm(TWO_AGENTS)).toMatchObject({
      ok: false,
      status: 409,
      error: { code: 'swarm_registered' },
    });
    expect(register).toHaveBeenCalledTimes(1);
  });

  it('AC-004-4: модель вне каталога — 400 model_not_found, register не вызван', async () => {
    const { deps, budgets } = fakeDeps({ registered: false });
    const register = vi.spyOn(budgets, 'register');
    const reg = {
      ...TWO_AGENTS,
      agents: [{ agentId: 'agent-1', model: 'gpt-unknown', budgetMicroUsd: null }],
    };
    expect(await createLlmGatewayCore(deps).registerSwarm(reg)).toMatchObject({
      ok: false,
      status: 400,
      error: { code: 'model_not_found' },
    });
    expect(register).not.toHaveBeenCalled();
  });

  it('AC-004-4: бюджет агента больше бюджета роя — 400 invalid_request, register не вызван', async () => {
    const { deps, budgets } = fakeDeps({ registered: false });
    const register = vi.spyOn(budgets, 'register');
    const reg = {
      ...TWO_AGENTS,
      budgetMicroUsd: 1000,
      agents: [{ agentId: 'agent-1', model: 'chat-small', budgetMicroUsd: 1001 }],
    };
    expect(await createLlmGatewayCore(deps).registerSwarm(reg)).toMatchObject({
      ok: false,
      status: 400,
      error: { code: 'invalid_request' },
    });
    expect(register).not.toHaveBeenCalled();
  });

  it('AC-004-8: закрытие роя — вызов от его агента дает 403, фейк не вызван; повторное закрытие — тот же spentMicroUsd; неизвестный рой — 404', async () => {
    const { deps, upstream } = fakeDeps({ registered: false, upstream: { complete: OK } });
    const core = createLlmGatewayCore(deps);
    await core.registerSwarm(TWO_AGENTS);
    const first = await core.closeSwarm(TEST_SWARM_ID);
    expect(first).toEqual({ ok: true, value: { spentMicroUsd: 0 } });
    expect(
      await core.complete({ swarmId: TEST_SWARM_ID, agentId: 'agent-1' }, body, signal),
    ).toMatchObject({
      kind: 'error',
      status: 403,
      error: { code: 'caller_not_registered' },
    });
    expect(upstream.calls).toEqual([]);
    expect(await core.closeSwarm(TEST_SWARM_ID)).toEqual(first);
    expect(await core.closeSwarm(OTHER_SWARM_ID)).toMatchObject({
      ok: false,
      status: 404,
      error: { code: 'not_found' },
    });
  });

  it('AC-004-8: closeSwarm с id не в формате UUID — 404 not_found, budgets.close не вызван', async () => {
    const { deps, budgets } = fakeDeps({ registered: false });
    const close = vi.spyOn(budgets, 'close');
    expect(await createLlmGatewayCore(deps).closeSwarm('not-a-uuid')).toMatchObject({
      ok: false,
      status: 404,
      error: { code: 'not_found' },
    });
    expect(close).not.toHaveBeenCalled();
  });

  it('AC-004-8: часы позже expiresAt — вызов дает 403, фейк не вызван', async () => {
    const { deps, upstream, clock } = fakeDeps({ registered: false, upstream: { complete: OK } });
    const core = createLlmGatewayCore(deps);
    await core.registerSwarm({ ...TWO_AGENTS, expiresAt: '2026-10-27T10:05:00.000Z' });
    clock.advance(300_000);
    expect(
      await core.complete({ swarmId: TEST_SWARM_ID, agentId: 'agent-1' }, body, signal),
    ).toMatchObject({
      kind: 'error',
      status: 403,
      error: { code: 'caller_not_registered' },
    });
    expect(upstream.calls).toEqual([]);
  });
});

describe('проверка вызывающего по регистрации', () => {
  it('AC-004-6: незарегистрированный рой и агент не из роя — 403 без резерва и события; агент роя с нужной моделью — 200', async () => {
    const { deps, upstream, events, budgets } = fakeDeps({
      registered: false,
      upstream: { complete: OK },
    });
    const core = createLlmGatewayCore(deps);
    await core.registerSwarm(TWO_AGENTS);

    expect(
      await core.complete({ swarmId: OTHER_SWARM_ID, agentId: 'agent-1' }, body, signal),
    ).toMatchObject({
      kind: 'error',
      status: 403,
      error: { code: 'caller_not_registered' },
    });
    expect(
      await core.complete({ swarmId: TEST_SWARM_ID, agentId: 'agent-3' }, body, signal),
    ).toMatchObject({
      kind: 'error',
      status: 403,
      error: { code: 'caller_not_registered' },
    });
    expect(upstream.calls).toEqual([]);
    expect(events.published).toEqual([]);
    expect(budgets.holdCallIds()).toEqual([]);
    expect(budgets.ledger).toEqual([]);

    const ok = await core.complete(
      { swarmId: TEST_SWARM_ID, agentId: 'agent-2' },
      { ...body, model: 'chat-large' },
      signal,
    );
    expect(ok.kind).toBe('json');
    expect(events.published[0]?.swarmId).toBe(TEST_SWARM_ID);
    expect(events.published[0]?.agentId).toBe('agent-2');
  });

  it('AC-004-7: модель запроса не модель агента из регистрации — 403 model_not_allowed, фейк не вызван, резерва и события нет', async () => {
    const { deps, upstream, events, budgets } = fakeDeps({ upstream: { complete: OK } });
    const result = await createLlmGatewayCore(deps).complete(
      { swarmId: TEST_SWARM_ID, agentId: 'agent-1' },
      { ...body, model: 'chat-large' },
      signal,
    );
    expect(result).toEqual({
      kind: 'error',
      status: 403,
      error: { message: 'Model is not allowed for this agent', code: 'model_not_allowed' },
    });
    expect(upstream.calls).toEqual([]);
    expect(events.published).toEqual([]);
    expect(budgets.holdCallIds()).toEqual([]);
    expect(budgets.swarm(TEST_SWARM_ID)).toEqual({ spentMicroUsd: 0, heldMicroUsd: 0 });
  });
});
