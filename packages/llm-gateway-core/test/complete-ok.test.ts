import { describe, expect, it } from 'vitest';
import { PlatformEventInput } from '@swag/contracts';
import { createLlmGatewayCore } from '../src/index.ts';
import type { UpstreamResponse } from '../src/index.ts';
import { fakeDeps } from './fakes.ts';

// Спека 002, 4.4 (шаги 1–7 обычного вызова), 4.10 (лог `llm call`), 4.3 (usage и стоимость). Без потока.

const SWARM_ID = '6f1c2a4e-8b3d-4e5f-9a1b-2c3d4e5f6a7b';
const TRACE_ID = '4bf92f3577b34da6a3ce929d0e0e4736';
const caller = { swarmId: SWARM_ID, agentId: 'agent-1' };
const signal = { aborted: false };
const CALL_ID = '00000000-0000-4000-8000-000000000001';
const EVENT_ID = '00000000-0000-4000-8000-000000000002';
const LATENCY_MS = 1234.6; // round → 1235

const body = {
  model: 'chat-small',
  messages: [{ role: 'user', content: 'привет' }],
  max_tokens: 1000,
  tools: [{ type: 'function', function: { name: 'lookup', parameters: {} } }],
  tool_choice: 'auto',
  temperature: 0.2,
};

const usageOf = (usage: Record<string, unknown>) => ({
  id: 'chatcmpl-1',
  object: 'chat.completion',
  choices: [{ index: 0, message: { role: 'assistant', content: 'fake reply' } }],
  usage,
});

// Фейк по умолчанию: usage с cost 0.0085 (4.3, AC-002-29).
const FULL_USAGE = {
  prompt_tokens: 1000,
  completion_tokens: 500,
  total_tokens: 1500,
  prompt_tokens_details: { cached_tokens: 200 },
  cost: 0.0085,
};
const OK: UpstreamResponse = { ok: true, body: usageOf(FULL_USAGE) };

// Ядро с апстримом, который тратит LATENCY_MS на вызов: задержка считается по monotonicMs.
function setup(upstreamResponse: UpstreamResponse = OK, options: { publishFails?: boolean } = {}) {
  const made = fakeDeps({ upstream: { complete: upstreamResponse }, ...options });
  const { deps, upstream, clock } = made;
  deps.upstream = {
    ...upstream,
    async complete(requestBody, requestSignal) {
      clock.advance(LATENCY_MS);
      return upstream.complete(requestBody, requestSignal);
    },
  };
  return { ...made, core: createLlmGatewayCore(deps) };
}

describe('complete без потока: успешный путь', () => {
  it('AC-002-1: апстриму уходит тело запроса без изменений, клиент получает тело ответа как есть', async () => {
    const { core, upstream } = setup();
    const result = await core.complete(caller, body, signal);
    expect(upstream.calls).toEqual([{ op: 'complete', body }]);
    expect(result).toEqual({ kind: 'json', body: usageOf(FULL_USAGE) });
  });

  it('AC-002-9: ровно одно событие llm.call, оно проходит PlatformEventInput и несёт поля по 4.4', async () => {
    const { core, events } = setup();
    await core.complete(caller, body, signal);
    expect(events.published).toHaveLength(1);
    const [event] = events.published;
    expect(PlatformEventInput.safeParse(event).success).toBe(true);
    expect(event).toEqual({
      id: EVENT_ID,
      swarmId: SWARM_ID,
      agentId: 'agent-1',
      ts: '2026-10-27T10:00:01.234Z', // время после ответа апстрима
      source: 'llm-gateway',
      traceId: null,
      type: 'llm.call',
      data: {
        callId: CALL_ID,
        model: 'chat-small',
        stream: false,
        status: 'ok',
        usage: { promptTokens: 1000, cachedPromptTokens: 200, completionTokens: 500 },
        costMicroUsd: 9960,
        providerCostMicroUsd: 8500,
        latencyMs: 1235,
        charge: { microUsd: 9960, basis: 'usage' },
      },
    });
  });

  it('AC-002-9: traceId события равен трейсу запроса', async () => {
    const { deps, events } = fakeDeps({ upstream: { complete: OK }, traceId: TRACE_ID });
    await createLlmGatewayCore(deps).complete(caller, body, signal);
    expect(events.published[0]).toMatchObject({ traceId: TRACE_ID });
  });

  it('AC-002-9: лог llm call уровня info с полями по 4.10 (null-значения не пишутся)', async () => {
    const { core, log } = setup();
    await core.complete(caller, body, signal);
    expect(log.entries).toStrictEqual([
      {
        level: 'info',
        msg: 'llm call',
        ctx: {
          callId: CALL_ID,
          swarmId: SWARM_ID,
          agentId: 'agent-1',
          model: 'chat-small',
          stream: false,
          status: 'ok',
          latencyMs: 1235,
          promptTokens: 1000,
          cachedPromptTokens: 200,
          completionTokens: 500,
          costMicroUsd: 9960,
          providerCostMicroUsd: 8500,
          chargeMicroUsd: 9960,
          chargeBasis: 'usage',
        },
      },
    ]);
  });
});

describe('complete без потока: usage отсутствует', () => {
  it.each([
    ['usage нет', {}],
    ['нет prompt_tokens', { completion_tokens: 500, cost: 0.0085 }],
    ['completion_tokens не целое', { prompt_tokens: 1000, completion_tokens: 2.5, cost: 0.0085 }],
  ])(
    'AC-002-14: %s — событие ok с usage, costMicroUsd и providerCostMicroUsd null',
    async (_, usage) => {
      const { core, events, log } = setup({ ok: true, body: usageOf(usage) });
      const result = await core.complete(caller, body, signal);
      expect(result.kind).toBe('json');
      expect(events.published[0]).toMatchObject({
        data: { status: 'ok', usage: null, costMicroUsd: null, providerCostMicroUsd: null },
      });
      expect(log.entries).toContainEqual({
        level: 'warn',
        msg: 'usage_missing',
        ctx: { callId: CALL_ID },
      });
    },
  );

  it('AC-002-14: лог llm call без полей usage и стоимости', async () => {
    const { core, log } = setup({ ok: true, body: usageOf({}) });
    await core.complete(caller, body, signal);
    expect(log.entries.at(-1)).toStrictEqual({
      level: 'info',
      msg: 'llm call',
      ctx: {
        callId: CALL_ID,
        swarmId: SWARM_ID,
        agentId: 'agent-1',
        model: 'chat-small',
        stream: false,
        status: 'ok',
        latencyMs: 1235,
        chargeMicroUsd: expect.any(Number),
        chargeBasis: 'estimate',
      },
    });
  });

  it('AC-002-14: при usage с полным набором полей usage_missing не пишется', async () => {
    const { core, log } = setup();
    await core.complete(caller, body, signal);
    expect(log.entries.some((entry) => entry.msg === 'usage_missing')).toBe(false);
  });
});

describe('complete без потока: providerCostMicroUsd', () => {
  it('AC-002-29: usage.cost 0.0085 → providerCostMicroUsd 8500, costMicroUsd 9960', async () => {
    const { core, events, log } = setup();
    await core.complete(caller, body, signal);
    expect(events.published[0]).toMatchObject({
      data: { providerCostMicroUsd: 8500, costMicroUsd: 9960 },
    });
    expect(log.entries.find((entry) => entry.msg === 'llm call')?.ctx).toMatchObject({
      providerCostMicroUsd: 8500,
      costMicroUsd: 9960,
    });
  });

  it('AC-002-29: нет usage.cost → providerCostMicroUsd null, costMicroUsd 9960', async () => {
    const { prompt_tokens, completion_tokens, prompt_tokens_details } = FULL_USAGE;
    const { core, events, log } = setup({
      ok: true,
      body: usageOf({ prompt_tokens, completion_tokens, prompt_tokens_details }),
    });
    await core.complete(caller, body, signal);
    expect(events.published[0]).toMatchObject({
      data: { providerCostMicroUsd: null, costMicroUsd: 9960 },
    });
    expect(log.entries.find((entry) => entry.msg === 'llm call')?.ctx).not.toHaveProperty(
      'providerCostMicroUsd',
    );
  });
});

describe('complete без потока: сбой публикации', () => {
  it('AC-002-9: сбой шины — лог error event_publish_failed с callId, ответ клиенту не меняется', async () => {
    const { core, log, events } = setup(OK, { publishFails: true });
    const result = await core.complete(caller, body, signal);
    expect(result).toEqual({ kind: 'json', body: usageOf(FULL_USAGE) });
    expect(events.published).toEqual([]);
    expect(log.entries).toContainEqual(
      expect.objectContaining({
        level: 'error',
        msg: 'event_publish_failed',
        ctx: expect.objectContaining({ callId: CALL_ID }),
      }),
    );
    expect(log.entries).toContainEqual(expect.objectContaining({ level: 'info', msg: 'llm call' }));
  });
});
