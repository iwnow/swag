import { describe, expect, it } from 'vitest';
import { PlatformEventInput } from '@swag/contracts';
import { createLlmGatewayCore } from '../src/index.ts';
import type { UpstreamFailure } from '../src/index.ts';
import { fakeDeps } from './fakes.ts';

// Спека 002, 4.4 (шаги 3, 5–7 обычного вызова), 4.6 (строки про апстрим), 4.10 (лог). Без потока.

const SWARM_ID = '6f1c2a4e-8b3d-4e5f-9a1b-2c3d4e5f6a7b';
const caller = { swarmId: SWARM_ID, agentId: 'agent-1' };
const signal = { aborted: false };
const CALL_ID = '00000000-0000-4000-8000-000000000001';
const LATENCY_MS = 1234.6; // round → 1235
const BAD_REQUEST = 'bad request: unsupported tool_choice';

const body = { model: 'chat-small', messages: [{ role: 'user', content: 'привет' }] };

// Апстрим тратит LATENCY_MS на отказ: задержка считается по monotonicMs и попадает в событие.
function setup(
  failure: UpstreamFailure | { kind: 'aborted' },
  options: { publishFails?: boolean } = {},
) {
  const made = fakeDeps({ upstream: { complete: { ok: false, failure } }, ...options });
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

// Строки таблицы 4.6 про апстрим. upstreamStatus — только для отказа http (в логе, не клиенту).
const ROWS = [
  {
    name: 'AC-002-15: http 400 → 400 upstream_bad_request, message апстрима',
    failure: { kind: 'http', status: 400, message: BAD_REQUEST } as const,
    status: 400,
    code: 'upstream_bad_request',
    message: BAD_REQUEST,
    upstreamStatus: 400,
  },
  {
    name: 'AC-002-15: http 422 → 400 upstream_bad_request, message апстрима',
    failure: { kind: 'http', status: 422, message: BAD_REQUEST } as const,
    status: 400,
    code: 'upstream_bad_request',
    message: BAD_REQUEST,
    upstreamStatus: 422,
  },
  {
    name: 'AC-002-15: http 429 → 429 rate_limited',
    failure: { kind: 'http', status: 429, message: 'too many requests' } as const,
    status: 429,
    code: 'rate_limited',
    message: 'Provider rate limit',
    upstreamStatus: 429,
  },
  {
    name: 'AC-002-15: http 500 → 502 upstream_error',
    failure: { kind: 'http', status: 500, message: 'boom' } as const,
    status: 502,
    code: 'upstream_error',
    message: 'Upstream error',
    upstreamStatus: 500,
  },
  {
    name: 'AC-002-15: http 503 (другой статус) → 502 upstream_error',
    failure: { kind: 'http', status: 503, message: 'unavailable' } as const,
    status: 502,
    code: 'upstream_error',
    message: 'Upstream error',
    upstreamStatus: 503,
  },
  {
    name: 'AC-002-15: сеть → 502 upstream_error, upstreamStatus нет',
    failure: { kind: 'network' } as const,
    status: 502,
    code: 'upstream_error',
    message: 'Upstream error',
    upstreamStatus: undefined,
  },
  {
    name: 'AC-002-16: таймаут → 504 upstream_timeout, upstreamStatus нет',
    failure: { kind: 'timeout' } as const,
    status: 504,
    code: 'upstream_timeout',
    message: 'Upstream timeout',
    upstreamStatus: undefined,
  },
];

describe('complete без потока: ошибки апстрима (таблица 4.6)', () => {
  it.each(ROWS)('$name', async ({ failure, status, code, message, upstreamStatus }) => {
    const { core, events, log } = setup(failure);
    const result = await core.complete(caller, body, signal);

    expect(result).toEqual({ kind: 'error', status, error: { message, code } });

    expect(events.published).toHaveLength(1);
    const [event] = events.published;
    expect(PlatformEventInput.safeParse(event).success).toBe(true);
    expect(event).toMatchObject({ type: 'llm.call', source: 'llm-gateway' });
    expect(event).toMatchObject({
      data: {
        callId: CALL_ID,
        model: 'chat-small',
        stream: false,
        status: 'error',
        usage: null,
        costMicroUsd: null,
        providerCostMicroUsd: null,
        latencyMs: 1235,
        errorCode: code,
      },
    });
    expect(event).not.toHaveProperty('data.upstreamStatus');

    const entry = log.entries.find((item) => item.msg === 'llm call');
    expect(entry).toStrictEqual({
      level: 'warn',
      msg: 'llm call',
      ctx: {
        callId: CALL_ID,
        swarmId: SWARM_ID,
        agentId: 'agent-1',
        model: 'chat-small',
        stream: false,
        status: 'error',
        latencyMs: 1235,
        errorCode: code,
        ...(upstreamStatus === undefined ? {} : { upstreamStatus }),
      },
    });
  });

  it('AC-002-15: сбой публикации при отказе апстрима — лог event_publish_failed, ответ клиенту не меняется', async () => {
    const { core, log, events } = setup(
      { kind: 'http', status: 429, message: 'slow down' },
      { publishFails: true },
    );
    const result = await core.complete(caller, body, signal);
    expect(result).toEqual({
      kind: 'error',
      status: 429,
      error: { message: 'Provider rate limit', code: 'rate_limited' },
    });
    expect(events.published).toEqual([]);
    expect(log.entries).toContainEqual(
      expect.objectContaining({
        level: 'error',
        msg: 'event_publish_failed',
        ctx: expect.objectContaining({ callId: CALL_ID }),
      }),
    );
    expect(log.entries).toContainEqual(expect.objectContaining({ level: 'warn', msg: 'llm call' }));
  });
});

// Спека 030, 4.5 (AC-030-8): обрыв клиентом у обычного вызова — aborted, не error.
describe('complete без потока: обрыв клиентом (спека 030, 4.5)', () => {
  it('AC-030-8: aborted → llm.call status aborted, usage null, без errorCode; лог info; клиенту 502 upstream_error', async () => {
    const { core, events, log } = setup({ kind: 'aborted' });
    const result = await core.complete(caller, body, signal);

    expect(result).toEqual({
      kind: 'error',
      status: 502,
      error: { message: 'Upstream error', code: 'upstream_error' },
    });

    expect(events.published).toHaveLength(1);
    const [event] = events.published;
    expect(PlatformEventInput.safeParse(event).success).toBe(true);
    expect(event).toMatchObject({
      data: {
        callId: CALL_ID,
        model: 'chat-small',
        stream: false,
        status: 'aborted',
        usage: null,
        costMicroUsd: null,
        providerCostMicroUsd: null,
        latencyMs: 1235,
      },
    });
    expect(event).not.toHaveProperty('data.errorCode');

    expect(log.entries.find((item) => item.msg === 'llm call')).toMatchObject({ level: 'info' });
  });

  it('AC-030-8: network → по-прежнему status error и errorCode upstream_error', async () => {
    const { core, events } = setup({ kind: 'network' });
    await core.complete(caller, body, signal);

    expect(events.published[0]).toMatchObject({
      data: { status: 'error', errorCode: 'upstream_error' },
    });
  });
});
