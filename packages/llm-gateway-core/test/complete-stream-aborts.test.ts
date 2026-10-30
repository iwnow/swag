import { describe, expect, it } from 'vitest';
import { createLlmGatewayCore, UpstreamStreamError } from '../src/index.ts';
import type { UpstreamFailure } from '../src/index.ts';
import { chunksThen, fakeDeps } from './fakes.ts';

// Спека 002, 4.4 (поток, шаг 5 и finally), 4.6 (строки про апстрим), 4.10 (лог). Тесты AC-002-12, -13 и потоковая часть AC-002-15.

const SWARM_ID = '6f1c2a4e-8b3d-4e5f-9a1b-2c3d4e5f6a7b';
const caller = { swarmId: SWARM_ID, agentId: 'agent-1' };
const signal = { aborted: false };
const CALL_ID = '00000000-0000-4000-8000-000000000001';
const BAD_REQUEST = 'bad request: unsupported tool_choice';

const body = {
  model: 'chat-small',
  messages: [{ role: 'user', content: 'привет' }],
  max_tokens: 256,
  stream: true,
};

const chunk = (delta: Record<string, unknown>) =>
  JSON.stringify({
    id: 'chatcmpl-1',
    object: 'chat.completion.chunk',
    choices: [{ index: 0, delta }],
  });

// Фрагмент с usage без cost: 800 некэшированных и 200 кэшированных входных, 500 выходных → costMicroUsd 9960.
const USAGE_CHUNK = JSON.stringify({
  choices: [],
  usage: {
    prompt_tokens: 1000,
    completion_tokens: 500,
    prompt_tokens_details: { cached_tokens: 200 },
  },
});

const errorPayload = (message: string, code: string) =>
  JSON.stringify({ error: { message, type: 'swag_gateway_error', code } });

async function run(payloads: string[], error?: UpstreamStreamError) {
  const chunks = chunksThen(payloads, error);
  const made = fakeDeps({ upstream: { stream: { ok: true, chunks } } });
  const result = await createLlmGatewayCore(made.deps).complete(caller, body, signal);
  if (result.kind !== 'stream') throw new Error('ожидался поток');
  return { ...made, chunks, result };
}

async function collect(chunks: AsyncIterable<string>): Promise<string[]> {
  const out: string[] = [];
  for await (const payload of chunks) out.push(payload);
  return out;
}

describe('complete с потоком: обрыв апстрима после первого фрагмента', () => {
  it('AC-002-12: последний payload — {"error":...} с code upstream_error, без [DONE], без исключения', async () => {
    const { result } = await run(
      [chunk({ content: 'fake' })],
      new UpstreamStreamError({ kind: 'network' }),
    );
    expect(await collect(result.chunks)).toEqual([
      chunk({ content: 'fake' }),
      errorPayload('Upstream error', 'upstream_error'),
    ]);
  });

  it('AC-002-12: событие одно, status aborted, errorCode upstream_error, usage и costMicroUsd null', async () => {
    const { result, events } = await run(
      [chunk({ content: 'fake' })],
      new UpstreamStreamError({ kind: 'network' }),
    );
    await collect(result.chunks);
    expect(events.published).toHaveLength(1);
    expect(events.published[0]).toMatchObject({
      data: {
        callId: CALL_ID,
        stream: true,
        status: 'aborted',
        errorCode: 'upstream_error',
        usage: null,
        costMicroUsd: null,
        providerCostMicroUsd: null,
      },
    });
  });

  it('AC-002-12: usage из уже полученных фрагментов попадает в событие', async () => {
    const { result, events } = await run(
      [USAGE_CHUNK, chunk({ content: 'fake' })],
      new UpstreamStreamError({ kind: 'network' }),
    );
    await collect(result.chunks);
    expect(events.published[0]).toMatchObject({
      data: {
        status: 'aborted',
        errorCode: 'upstream_error',
        usage: { promptTokens: 1000, cachedPromptTokens: 200, completionTokens: 500 },
        costMicroUsd: 9960,
      },
    });
  });

  it('AC-002-12: лог llm call уровня warn с errorCode, без upstreamStatus у сетевого обрыва', async () => {
    const { result, log } = await run(
      [chunk({ content: 'fake' })],
      new UpstreamStreamError({ kind: 'network' }),
    );
    await collect(result.chunks);
    const logged = log.entries.find((entry) => entry.msg === 'llm call');
    expect(logged?.level).toBe('warn');
    expect(logged?.ctx).toMatchObject({ status: 'aborted', errorCode: 'upstream_error' });
    expect(logged?.ctx).not.toHaveProperty('upstreamStatus');
  });
});

describe('complete с потоком: обрыв после старта по таблице 4.6 (AC-002-15)', () => {
  const ROWS = [
    {
      name: 'http 400 → upstream_bad_request, message апстрима',
      failure: { kind: 'http', status: 400, message: BAD_REQUEST } as UpstreamFailure,
      code: 'upstream_bad_request',
      message: BAD_REQUEST,
      upstreamStatus: 400,
    },
    {
      name: 'http 422 → upstream_bad_request, message апстрима',
      failure: { kind: 'http', status: 422, message: BAD_REQUEST } as UpstreamFailure,
      code: 'upstream_bad_request',
      message: BAD_REQUEST,
      upstreamStatus: 422,
    },
    {
      name: 'http 429 → rate_limited',
      failure: { kind: 'http', status: 429, message: 'too many requests' } as UpstreamFailure,
      code: 'rate_limited',
      message: 'Provider rate limit',
      upstreamStatus: 429,
    },
    {
      name: 'http 500 → upstream_error',
      failure: { kind: 'http', status: 500, message: 'boom' } as UpstreamFailure,
      code: 'upstream_error',
      message: 'Upstream error',
      upstreamStatus: 500,
    },
    {
      name: 'сеть → upstream_error',
      failure: { kind: 'network' } as UpstreamFailure,
      code: 'upstream_error',
      message: 'Upstream error',
      upstreamStatus: undefined,
    },
    {
      name: 'таймаут → upstream_timeout',
      failure: { kind: 'timeout' } as UpstreamFailure,
      code: 'upstream_timeout',
      message: 'Upstream timeout',
      upstreamStatus: undefined,
    },
  ];

  it.each(ROWS)('AC-002-15: $name', async (row) => {
    const { result, events, log } = await run(
      [chunk({ content: 'fake' })],
      new UpstreamStreamError(row.failure),
    );
    const payloads = await collect(result.chunks);
    expect(payloads.at(-1)).toBe(errorPayload(row.message, row.code));
    expect(payloads).not.toContain('[DONE]');
    expect(events.published).toHaveLength(1);
    expect(events.published[0]).toMatchObject({
      data: { status: 'aborted', errorCode: row.code },
    });
    const logged = log.entries.find((entry) => entry.msg === 'llm call');
    expect(logged?.ctx?.upstreamStatus).toBe(row.upstreamStatus);
  });
});

describe('complete с потоком: клиент ушёл (AC-002-13)', () => {
  it('AC-002-13: клиент прервал чтение после первого фрагмента — aborted без errorCode, апстрим закрыт', async () => {
    const { result, chunks, events } = await run([
      chunk({ content: 'fake' }),
      chunk({ content: ' reply' }),
      '[DONE]',
    ]);
    const iterator = result.chunks[Symbol.asyncIterator]();
    await iterator.next();
    await iterator.return?.();
    expect(chunks.closed).toBe(true);
    expect(events.published).toHaveLength(1);
    expect(events.published[0]).toMatchObject({ data: { status: 'aborted' } });
    expect(events.published[0]?.data).not.toHaveProperty('errorCode');
  });

  it('AC-002-13: апстрим отдал aborted — payload ошибки не пишется, исключение доходит до потребителя, событие без errorCode', async () => {
    const { result, events, log } = await run(
      [chunk({ content: 'fake' })],
      new UpstreamStreamError({ kind: 'aborted' }),
    );
    const out: string[] = [];
    const read = async () => {
      for await (const payload of result.chunks) out.push(payload);
    };
    await expect(read()).rejects.toBeInstanceOf(UpstreamStreamError);
    expect(out).toEqual([chunk({ content: 'fake' })]);
    expect(events.published).toHaveLength(1);
    expect(events.published[0]).toMatchObject({ data: { status: 'aborted' } });
    expect(events.published[0]?.data).not.toHaveProperty('errorCode');
    const logged = log.entries.find((entry) => entry.msg === 'llm call');
    expect(logged?.level).toBe('warn');
    expect(logged?.ctx).not.toHaveProperty('errorCode');
  });
});
