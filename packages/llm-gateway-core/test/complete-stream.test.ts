import { describe, expect, it } from 'vitest';
import { PlatformEventInput } from '@swag/contracts';
import { createLlmGatewayCore } from '../src/index.ts';
import type { UpstreamFailure } from '../src/index.ts';
import { chunksThen, fakeDeps } from './fakes.ts';

// Спека 002, 4.4 (поток, шаги 1–4 и отказ до первого фрагмента), 4.3 (usage и стоимость), 4.10 (лог).

const SWARM_ID = '6f1c2a4e-8b3d-4e5f-9a1b-2c3d4e5f6a7b';
const TRACE_ID = '4bf92f3577b34da6a3ce929d0e0e4736';
const caller = { swarmId: SWARM_ID, agentId: 'agent-1' };
const signal = { aborted: false };
const CALL_ID = '00000000-0000-4000-8000-000000000001';
const LATENCY_MS = 1234.6; // round → 1235; Date усекает миллисекунды → 01.234
const BAD_REQUEST = 'bad request: unsupported tool_choice';

const body = {
  model: 'chat-small',
  messages: [{ role: 'user', content: 'привет' }],
  tools: [{ type: 'function', function: { name: 'lookup', parameters: {} } }],
  stream: true,
};

const chunk = (delta: Record<string, unknown>) =>
  JSON.stringify({
    id: 'chatcmpl-1',
    object: 'chat.completion.chunk',
    choices: [{ index: 0, delta }],
  });

// Фейк по умолчанию (AC-002-10, AC-002-29): два текстовых фрагмента, фрагмент с usage и cost 0.0085, [DONE].
const FULL_USAGE = {
  prompt_tokens: 1000,
  completion_tokens: 500,
  total_tokens: 1500,
  prompt_tokens_details: { cached_tokens: 200 },
  cost: 0.0085,
};
const USAGE_CHUNK = JSON.stringify({
  id: 'chatcmpl-1',
  object: 'chat.completion.chunk',
  choices: [],
  usage: FULL_USAGE,
});
const PAYLOADS = [
  chunk({ role: 'assistant', content: 'fake' }),
  chunk({ content: ' reply' }),
  USAGE_CHUNK,
  '[DONE]',
];

// Апстрим тратит LATENCY_MS на вызов потока; задержка события считается по monotonicMs (как в complete-errors).
function setup(
  payloads: string[] = PAYLOADS,
  options: { publishFails?: boolean; traceId?: string | null } = {},
) {
  const made = fakeDeps({
    upstream: { stream: { ok: true, chunks: chunksThen(payloads) } },
    ...options,
  });
  const { deps, upstream, clock } = made;
  deps.upstream = {
    ...upstream,
    async stream(requestBody, requestSignal) {
      clock.advance(LATENCY_MS);
      return upstream.stream(requestBody, requestSignal);
    },
  };
  return { ...made, core: createLlmGatewayCore(deps) };
}

async function collect(chunks: AsyncIterable<string>): Promise<string[]> {
  const out: string[] = [];
  for await (const payload of chunks) out.push(payload);
  return out;
}

describe('complete с потоком: успешный путь', () => {
  it('AC-002-10: клиент получает payloads в исходном порядке, включая [DONE]', async () => {
    const { core } = setup();
    const result = await core.complete(caller, body, signal);
    expect(result.kind).toBe('stream');
    if (result.kind !== 'stream') return;
    expect(await collect(result.chunks)).toEqual(PAYLOADS);
  });

  it('AC-002-10: апстрим получает stream_options.include_usage = true, тело клиента не меняется', async () => {
    const { core, upstream } = setup();
    const clientBody = structuredClone(body);
    const expected = structuredClone(body);
    const result = await core.complete(caller, clientBody, signal);
    if (result.kind === 'stream') await collect(result.chunks);
    expect(upstream.calls).toEqual([
      { op: 'stream', body: { ...expected, stream_options: { include_usage: true } } },
    ]);
    expect(clientBody).toStrictEqual(expected);
    expect(clientBody).not.toHaveProperty('stream_options');
  });

  it('AC-002-10: stream_options клиента сохраняются, include_usage выставляется в true, исходный объект не меняется', async () => {
    const { core, upstream } = setup();
    const streamOptions = { include_usage: false, other: 1 };
    const result = await core.complete(caller, { ...body, stream_options: streamOptions }, signal);
    if (result.kind === 'stream') await collect(result.chunks);
    expect(upstream.calls[0]?.body?.stream_options).toStrictEqual({
      include_usage: true,
      other: 1,
    });
    expect(streamOptions).toStrictEqual({ include_usage: false, other: 1 });
  });

  it('AC-002-10: usage берётся из последнего фрагмента, где оно есть; фрагмент не по JSON отдаётся без изменений', async () => {
    const earlier = JSON.stringify({
      choices: [],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    });
    const payloads = [chunk({ content: 'x' }), earlier, USAGE_CHUNK, 'not json', '[DONE]'];
    const { core, events } = setup(payloads);
    const result = await core.complete(caller, body, signal);
    if (result.kind !== 'stream') throw new Error('ожидался поток');
    expect(await collect(result.chunks)).toEqual(payloads);
    expect(events.published[0]).toMatchObject({
      data: { usage: { promptTokens: 1000, cachedPromptTokens: 200, completionTokens: 500 } },
    });
  });

  it('AC-002-10: поток без usage — usage и costMicroUsd null, лог usage_missing не пишется (D-61, вариант А)', async () => {
    const { core, events, log } = setup([chunk({ content: 'fake' }), '[DONE]']);
    const result = await core.complete(caller, body, signal);
    if (result.kind === 'stream') await collect(result.chunks);
    expect(events.published[0]).toMatchObject({
      data: { status: 'ok', usage: null, costMicroUsd: null, providerCostMicroUsd: null },
    });
    expect(log.entries.map((entry) => entry.msg)).not.toContain('usage_missing');
  });

  it('AC-002-10: return() после первого next() — одно событие aborted без usage, итератор апстрима закрыт', async () => {
    const chunks = chunksThen(PAYLOADS);
    const { deps, events } = fakeDeps({ upstream: { stream: { ok: true, chunks } } });
    const result = await createLlmGatewayCore(deps).complete(caller, body, signal);
    if (result.kind !== 'stream') throw new Error('ожидался поток');
    const iterator = result.chunks[Symbol.asyncIterator]();
    expect(await iterator.next()).toEqual({ done: false, value: PAYLOADS[0] });
    await iterator.return?.();
    expect(chunks.closed).toBe(true);
    expect(events.published).toHaveLength(1);
    expect(events.published[0]).toMatchObject({
      data: { status: 'aborted', usage: null, costMicroUsd: null, providerCostMicroUsd: null },
    });
  });

  it('AC-002-10: событие публикуется один раз, после завершения потока', async () => {
    const { core, events } = setup();
    const result = await core.complete(caller, body, signal);
    expect(events.published).toEqual([]);
    if (result.kind === 'stream') await collect(result.chunks);
    expect(events.published).toHaveLength(1);
  });

  it('AC-002-10: событие status ok, stream true, usage из фрагмента, costMicroUsd 9960', async () => {
    const { core, events } = setup();
    const result = await core.complete(caller, body, signal);
    if (result.kind === 'stream') await collect(result.chunks);
    const [event] = events.published;
    expect(PlatformEventInput.safeParse(event).success).toBe(true);
    expect(event).toEqual({
      id: '00000000-0000-4000-8000-000000000002',
      swarmId: SWARM_ID,
      agentId: 'agent-1',
      ts: '2026-10-27T10:00:01.234Z',
      source: 'llm-gateway',
      traceId: null,
      type: 'llm.call',
      data: {
        callId: CALL_ID,
        model: 'chat-small',
        stream: true,
        status: 'ok',
        usage: { promptTokens: 1000, cachedPromptTokens: 200, completionTokens: 500 },
        costMicroUsd: 9960,
        providerCostMicroUsd: 8500,
        latencyMs: 1235,
      },
    });
  });

  it('AC-002-10: traceId события равен трейсу запроса', async () => {
    const { core, events } = setup(PAYLOADS, { traceId: TRACE_ID });
    const result = await core.complete(caller, body, signal);
    if (result.kind === 'stream') await collect(result.chunks);
    expect(events.published[0]).toMatchObject({ traceId: TRACE_ID });
  });

  it('AC-002-10: лог llm call уровня info с полями по 4.10', async () => {
    const { core, log } = setup();
    const result = await core.complete(caller, body, signal);
    if (result.kind === 'stream') await collect(result.chunks);
    expect(log.entries).toStrictEqual([
      {
        level: 'info',
        msg: 'llm call',
        ctx: {
          callId: CALL_ID,
          swarmId: SWARM_ID,
          agentId: 'agent-1',
          model: 'chat-small',
          stream: true,
          status: 'ok',
          latencyMs: 1235,
          promptTokens: 1000,
          cachedPromptTokens: 200,
          completionTokens: 500,
          costMicroUsd: 9960,
          providerCostMicroUsd: 8500,
        },
      },
    ]);
  });

  it('AC-002-9: сбой публикации в конце потока — лог event_publish_failed, payloads отданы клиенту', async () => {
    const { core, log, events } = setup(PAYLOADS, { publishFails: true });
    const result = await core.complete(caller, body, signal);
    if (result.kind !== 'stream') throw new Error('ожидался поток');
    expect(await collect(result.chunks)).toEqual(PAYLOADS);
    expect(events.published).toEqual([]);
    expect(log.entries).toContainEqual(
      expect.objectContaining({
        level: 'error',
        msg: 'event_publish_failed',
        ctx: expect.objectContaining({ callId: CALL_ID }),
      }),
    );
  });
});

describe('complete с потоком: стоимость у провайдера', () => {
  it('AC-002-29: поток — providerCostMicroUsd 8500, costMicroUsd 9960', async () => {
    const { core, events } = setup();
    const result = await core.complete(caller, body, signal);
    if (result.kind === 'stream') await collect(result.chunks);
    expect(events.published[0]).toMatchObject({
      data: { providerCostMicroUsd: 8500, costMicroUsd: 9960 },
    });
  });

  it('AC-002-29: поток без usage.cost — providerCostMicroUsd null, costMicroUsd 9960', async () => {
    const { prompt_tokens, completion_tokens, prompt_tokens_details } = FULL_USAGE;
    const usage = JSON.stringify({
      choices: [],
      usage: { prompt_tokens, completion_tokens, prompt_tokens_details },
    });
    const { core, events } = setup([usage, '[DONE]']);
    const result = await core.complete(caller, body, signal);
    if (result.kind === 'stream') await collect(result.chunks);
    expect(events.published[0]).toMatchObject({
      data: { providerCostMicroUsd: null, costMicroUsd: 9960 },
    });
  });
});

describe('complete с потоком: отказ до первого фрагмента', () => {
  // Строки таблицы 4.6 про апстрим, как в T-16 (complete-errors.test.ts), но для потока.
  const ROWS = [
    {
      name: 'http 400 → 400 upstream_bad_request, message апстрима',
      failure: { kind: 'http', status: 400, message: BAD_REQUEST } as UpstreamFailure,
      status: 400,
      code: 'upstream_bad_request',
      message: BAD_REQUEST,
      upstreamStatus: 400,
    },
    {
      name: 'http 422 → 400 upstream_bad_request, message апстрима',
      failure: { kind: 'http', status: 422, message: BAD_REQUEST } as UpstreamFailure,
      status: 400,
      code: 'upstream_bad_request',
      message: BAD_REQUEST,
      upstreamStatus: 422,
    },
    {
      name: 'http 429 → 429 rate_limited',
      failure: { kind: 'http', status: 429, message: 'too many requests' } as UpstreamFailure,
      status: 429,
      code: 'rate_limited',
      message: 'Provider rate limit',
      upstreamStatus: 429,
    },
    {
      name: 'http 500 → 502 upstream_error',
      failure: { kind: 'http', status: 500, message: 'boom' } as UpstreamFailure,
      status: 502,
      code: 'upstream_error',
      message: 'Upstream error',
      upstreamStatus: 500,
    },
    {
      name: 'сеть → 502 upstream_error, upstreamStatus нет',
      failure: { kind: 'network' } as UpstreamFailure,
      status: 502,
      code: 'upstream_error',
      message: 'Upstream error',
      upstreamStatus: undefined,
    },
    {
      name: 'таймаут → 504 upstream_timeout',
      failure: { kind: 'timeout' } as UpstreamFailure,
      status: 504,
      code: 'upstream_timeout',
      message: 'Upstream timeout',
      upstreamStatus: undefined,
    },
  ];

  it.each(ROWS)('AC-002-15: $name', async (row) => {
    const made = fakeDeps({ upstream: { stream: { ok: false, failure: row.failure } } });
    const { deps, upstream, clock, events, log } = made;
    deps.upstream = {
      ...upstream,
      async stream(requestBody, requestSignal) {
        clock.advance(LATENCY_MS);
        return upstream.stream(requestBody, requestSignal);
      },
    };
    const result = await createLlmGatewayCore(deps).complete(caller, body, signal);
    expect(result).toEqual({
      kind: 'error',
      status: row.status,
      error: { message: row.message, code: row.code },
    });
    expect(events.published).toHaveLength(1);
    expect(events.published[0]).toMatchObject({
      data: {
        callId: CALL_ID,
        stream: true,
        status: 'error',
        usage: null,
        costMicroUsd: null,
        providerCostMicroUsd: null,
        latencyMs: 1235,
        errorCode: row.code,
      },
    });
    const logged = log.entries.find((entry) => entry.msg === 'llm call');
    expect(logged?.level).toBe('warn');
    expect(logged?.ctx?.upstreamStatus).toBe(row.upstreamStatus);
  });

  it('AC-002-15: отказ до потока — апстрим вызван один раз со stream_options.include_usage', async () => {
    const { deps, upstream } = fakeDeps({
      upstream: { stream: { ok: false, failure: { kind: 'network' } } },
    });
    await createLlmGatewayCore(deps).complete(caller, body, signal);
    expect(upstream.calls).toEqual([
      { op: 'stream', body: { ...body, stream_options: { include_usage: true } } },
    ]);
  });
});
