import { describe, expect, it } from 'vitest';
import type { ChatRequest } from '../src/index.ts';
import { createLlmGatewayCore, inputBytes, UpstreamStreamError } from '../src/index.ts';
import { chunksThen, fakeDeps, TEST_SWARM_ID } from './fakes.ts';

// Спека 004, 4.3 и 4.4: резерв до апстрима, списание после, события и логи денег.

const signal = { aborted: false };
const caller = { swarmId: TEST_SWARM_ID, agentId: 'agent-1' };
const body = {
  model: 'chat-small',
  messages: [{ role: 'user', content: 'привет' }],
  max_tokens: 1000,
};
const streamBody: ChatRequest = { ...body, stream: true };
const USAGE = {
  prompt_tokens: 1000,
  completion_tokens: 500,
  prompt_tokens_details: { cached_tokens: 200 },
  cost: 0.0085,
};
const OK = {
  ok: true,
  body: { choices: [{ message: { content: 'ответ' } }], usage: USAGE },
} as const;
const ERROR_500 = {
  ok: false,
  failure: { kind: 'http', status: 500, message: 'HTTP 500' },
} as const;

const delta = (content: string) => JSON.stringify({ choices: [{ delta: { content } }] });
const USAGE_CHUNK = JSON.stringify({ choices: [{ delta: { content: 'привет' } }], usage: USAGE });

async function drain(chunks: AsyncIterable<string>): Promise<void> {
  for await (const chunk of chunks) void chunk;
}

describe('запрос без max_tokens', () => {
  it.each([
    ['нет max_tokens', { model: 'chat-small', messages: body.messages }],
    ['max_tokens 0', { ...body, max_tokens: 0 }],
    ['max_tokens 1.5', { ...body, max_tokens: 1.5 }],
    ['max_tokens "10"', { ...body, max_tokens: '10' }],
    ['max_tokens null', { ...body, max_tokens: null }],
  ])('AC-004-10: %s — 400 invalid_request, фейк не вызван', async (_, raw) => {
    const { deps, upstream, events } = fakeDeps({ upstream: { complete: OK } });
    const result = await createLlmGatewayCore(deps).complete(caller, raw, signal);
    expect(result).toMatchObject({
      kind: 'error',
      status: 400,
      error: { code: 'invalid_request' },
    });
    expect(upstream.calls).toEqual([]);
    expect(events.published).toEqual([]);
  });
});

describe('бюджет роя и агента', () => {
  it.each([
    ['без потока', body],
    ['потоком', streamBody],
  ])(
    'AC-004-11: бюджет роя меньше резерва, %s — 402 swarm_budget_exceeded, фейк, резерв и ledger не тронуты',
    async (_, raw) => {
      const { deps, upstream, events, budgets, log } = fakeDeps({
        registered: false,
        upstream: { complete: OK, stream: { ok: true, chunks: chunksThen([]) } },
      });
      budgets.seed({
        swarmId: TEST_SWARM_ID,
        budgetMicroUsd: 1,
        expiresAt: null,
        agents: [{ agentId: 'agent-1', model: 'chat-small', budgetMicroUsd: null }],
      });
      const result = await createLlmGatewayCore(deps).complete(caller, raw, signal);
      expect(result).toEqual({
        kind: 'error',
        status: 402,
        error: { message: 'Swarm budget exceeded', code: 'swarm_budget_exceeded' },
      });
      expect(upstream.calls).toEqual([]);
      expect(budgets.swarm(TEST_SWARM_ID)).toEqual({ spentMicroUsd: 0, heldMicroUsd: 0 });
      expect(budgets.ledger).toEqual([]);
      expect(events.published).toEqual([]);
      expect(log.entries).toContainEqual(
        expect.objectContaining({ level: 'warn', msg: 'budget_exceeded' }),
      );
    },
  );

  it('AC-004-12: бюджет agent-1 меньше резерва — 402 agent_budget_exceeded; agent-2 без бюджета агента — 200', async () => {
    const { deps, budgets } = fakeDeps({ registered: false, upstream: { complete: OK } });
    budgets.seed({
      swarmId: TEST_SWARM_ID,
      budgetMicroUsd: 1_000_000_000,
      expiresAt: null,
      agents: [
        { agentId: 'agent-1', model: 'chat-small', budgetMicroUsd: 1 },
        { agentId: 'agent-2', model: 'chat-small', budgetMicroUsd: null },
      ],
    });
    const core = createLlmGatewayCore(deps);
    expect(
      await core.complete({ swarmId: TEST_SWARM_ID, agentId: 'agent-1' }, body, signal),
    ).toEqual({
      kind: 'error',
      status: 402,
      error: { message: 'Agent budget exceeded', code: 'agent_budget_exceeded' },
    });
    expect(
      await core.complete({ swarmId: TEST_SWARM_ID, agentId: 'agent-2' }, body, signal),
    ).toMatchObject({ kind: 'json' });
  });
});

describe('списание после вызова', () => {
  it('AC-004-15: без потока с usage — charge usage; событие и ledger несут одно и то же', async () => {
    const { deps, events, budgets } = fakeDeps({ upstream: { complete: OK } });
    await createLlmGatewayCore(deps).complete(caller, body, signal);
    const [event] = events.published;
    const data = event?.data as { charge: unknown; providerCostMicroUsd: number | null };
    expect(data.charge).toEqual({ microUsd: 9960, basis: 'usage' });
    expect(budgets.ledger).toEqual([
      expect.objectContaining({
        amountMicroUsd: 9960,
        basis: 'usage',
        providerCostMicroUsd: data.providerCostMicroUsd,
      }),
    ]);
    expect(budgets.holdCallIds()).toEqual([]);
    expect(budgets.swarm(TEST_SWARM_ID)?.heldMicroUsd).toBe(0);
  });

  it('AC-004-15: поток с usage — charge usage', async () => {
    const { deps, events, budgets } = fakeDeps({
      upstream: {
        stream: { ok: true, chunks: chunksThen([delta('привет'), USAGE_CHUNK, '[DONE]']) },
      },
    });
    const result = await createLlmGatewayCore(deps).complete(caller, streamBody, signal);
    if (result.kind === 'stream') await drain(result.chunks);
    expect(events.published[0]?.data).toMatchObject({
      charge: { microUsd: 9960, basis: 'usage' },
    });
    expect(budgets.ledger).toHaveLength(1);
    expect(budgets.ledger[0]).toMatchObject({ amountMicroUsd: 9960, basis: 'usage' });
    expect(budgets.holdCallIds()).toEqual([]);
    expect(budgets.swarm(TEST_SWARM_ID)?.heldMicroUsd).toBe(0);
  });

  it('AC-004-15: поток без usage, оборван после двух фрагментов — estimate по байтам дошедших фрагментов, status aborted', async () => {
    const { deps, events, budgets } = fakeDeps({
      upstream: {
        stream: {
          ok: true,
          chunks: chunksThen(
            [delta('абв'), delta('где')],
            new UpstreamStreamError({ kind: 'network' }),
          ),
        },
      },
    });
    const result = await createLlmGatewayCore(deps).complete(caller, streamBody, signal);
    if (result.kind === 'stream') await drain(result.chunks);
    const outBytes = Buffer.byteLength('абвгде');
    const expected = Math.ceil((inputBytes(streamBody) * 30_000 + outBytes * 150_000) / 10_000);
    expect(events.published[0]?.data).toMatchObject({
      status: 'aborted',
      charge: { microUsd: expected, basis: 'estimate' },
    });
    expect(budgets.ledger).toHaveLength(1);
    expect(budgets.ledger[0]).toMatchObject({ amountMicroUsd: expected, basis: 'estimate' });
    expect(budgets.holdCallIds()).toEqual([]);
    expect(budgets.swarm(TEST_SWARM_ID)?.heldMicroUsd).toBe(0);
  });

  it('AC-004-15: потребитель взял первый фрагмент и вызвал return() — байты фрагмента в estimate, одна запись ledger, held 0', async () => {
    const { deps, events, budgets } = fakeDeps({
      upstream: { stream: { ok: true, chunks: chunksThen([delta('абв'), delta('где')]) } },
    });
    const result = await createLlmGatewayCore(deps).complete(caller, streamBody, signal);
    if (result.kind !== 'stream') throw new Error(`ожидался поток, пришло: ${result.kind}`);
    const iterator = result.chunks[Symbol.asyncIterator]();
    await iterator.next();
    await iterator.return?.(undefined);
    const expected = Math.ceil(
      (inputBytes(streamBody) * 30_000 + Buffer.byteLength('абв') * 150_000) / 10_000,
    );
    expect(events.published[0]?.data).toMatchObject({
      status: 'aborted',
      charge: { microUsd: expected, basis: 'estimate' },
    });
    expect(budgets.ledger).toHaveLength(1);
    expect(budgets.ledger[0]).toMatchObject({ amountMicroUsd: expected, basis: 'estimate' });
    expect(budgets.holdCallIds()).toEqual([]);
    expect(budgets.swarm(TEST_SWARM_ID)?.heldMicroUsd).toBe(0);
  });

  it('AC-004-15: обычный вызов бросает не-UpstreamFailure — резерв закрыт, charge 0, ровно одна запись ledger, исключение проброшено', async () => {
    const { deps, events, budgets } = fakeDeps();
    deps.upstream = {
      ...deps.upstream,
      complete: async () => {
        throw new Error('boom');
      },
    };
    await expect(createLlmGatewayCore(deps).complete(caller, body, signal)).rejects.toThrow('boom');
    expect(events.published[0]?.data).toMatchObject({
      status: 'error',
      charge: { microUsd: 0, basis: 'none' },
    });
    expect(budgets.ledger).toHaveLength(1);
    expect(budgets.ledger[0]).toMatchObject({ amountMicroUsd: 0, basis: 'none' });
    expect(budgets.holdCallIds()).toEqual([]);
    expect(budgets.swarm(TEST_SWARM_ID)).toEqual({ spentMicroUsd: 0, heldMicroUsd: 0 });
  });

  it('AC-004-15: поток бросает до первого фрагмента — резерв закрыт, charge 0, ровно одна запись ledger, исключение проброшено', async () => {
    const { deps, events, budgets } = fakeDeps();
    deps.upstream = {
      ...deps.upstream,
      stream: async () => {
        throw new Error('boom');
      },
    };
    await expect(createLlmGatewayCore(deps).complete(caller, streamBody, signal)).rejects.toThrow(
      'boom',
    );
    expect(events.published[0]?.data).toMatchObject({
      status: 'error',
      charge: { microUsd: 0, basis: 'none' },
    });
    expect(budgets.ledger).toHaveLength(1);
    expect(budgets.holdCallIds()).toEqual([]);
    expect(budgets.swarm(TEST_SWARM_ID)).toEqual({ spentMicroUsd: 0, heldMicroUsd: 0 });
  });

  it('AC-004-15: отказ апстрима 500 — charge 0, основание none', async () => {
    const { deps, events, budgets } = fakeDeps({ upstream: { complete: ERROR_500 } });
    await createLlmGatewayCore(deps).complete(caller, body, signal);
    expect(events.published[0]?.data).toMatchObject({
      status: 'error',
      charge: { microUsd: 0, basis: 'none' },
    });
    expect(budgets.ledger[0]).toMatchObject({ amountMicroUsd: 0, basis: 'none' });
    expect(budgets.swarm(TEST_SWARM_ID)).toEqual({ spentMicroUsd: 0, heldMicroUsd: 0 });
  });

  it('AC-004-16: usage дороже резерва — списана стоимость по usage, лог warn hold_exceeded', async () => {
    const { deps, events, log } = fakeDeps({ upstream: { complete: OK } });
    await createLlmGatewayCore(deps).complete(caller, { ...body, max_tokens: 1 }, signal);
    expect(events.published[0]?.data).toMatchObject({
      charge: { microUsd: 9960, basis: 'usage' },
    });
    expect(log.entries).toContainEqual({
      level: 'warn',
      msg: 'hold_exceeded',
      ctx: { callId: expect.any(String), holdMicroUsd: expect.any(Number), chargeMicroUsd: 9960 },
    });
  });

  it('AC-004-17: settle бросает — ответ клиенту 200, событие с charge опубликовано, лог error settle_failed', async () => {
    const { deps, events, log, budgets } = fakeDeps({
      upstream: { complete: OK },
      settleFails: true,
    });
    const result = await createLlmGatewayCore(deps).complete(caller, body, signal);
    expect(result).toEqual({ kind: 'json', body: OK.body });
    expect(budgets.holdCallIds()).toHaveLength(1);
    expect(events.published[0]?.data).toMatchObject({
      charge: { microUsd: 9960, basis: 'usage' },
    });
    expect(log.entries).toContainEqual(
      expect.objectContaining({
        level: 'error',
        msg: 'settle_failed',
        ctx: expect.objectContaining({ callId: expect.any(String) }),
      }),
    );
  });

  it('AC-004-18: releaseHolds снимает резервы прошлого процесса без списания, по warn на каждый', async () => {
    const { deps, budgets, log } = fakeDeps();
    await budgets.reserve('11111111-1111-4111-8111-111111111111', caller, 1000, new Date());
    await budgets.reserve('22222222-2222-4222-8222-222222222222', caller, 2000, new Date());
    expect(budgets.swarm(TEST_SWARM_ID)).toEqual({ spentMicroUsd: 0, heldMicroUsd: 3000 });

    expect(await createLlmGatewayCore(deps).releaseHolds()).toBe(2);
    expect(budgets.holdCallIds()).toEqual([]);
    expect(budgets.swarm(TEST_SWARM_ID)).toEqual({ spentMicroUsd: 0, heldMicroUsd: 0 });
    expect(budgets.agent(TEST_SWARM_ID, 'agent-1')).toEqual({ spentMicroUsd: 0, heldMicroUsd: 0 });
    expect(budgets.ledger).toEqual([]);
    expect(log.entries.filter((entry) => entry.msg === 'hold_released')).toHaveLength(2);
  });
});
