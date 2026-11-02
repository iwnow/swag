import { describe, expect, it } from 'vitest';
import type { HostFrame, NodeInvocation, NodeInvocationErrorCode } from '@swag/contracts';
import { createOrchestratorCore } from '../src/index.ts';
import { FAKE_SECRET, NOW, ORG, nodeHarness, type Respond } from './node-fakes.ts';

const ECHO = 'example/echo@1.0.0';
const API = 'example/api@1.0.0';
const TICK = 'example/tick@1.0.0';
const AGENT = 'swag/llm-agent@1.0.0';

function invocation(overrides: Partial<NodeInvocation> = {}): NodeInvocation {
  return {
    orgId: ORG,
    type: ECHO,
    call: { kind: 'execute', input: { text: 'hi' } },
    settings: { prefix: '> ' },
    credentials: {},
    stateKey: 'node-1',
    ...overrides,
  };
}

function apiInvocation(overrides: Partial<NodeInvocation> = {}): NodeInvocation {
  return invocation({
    type: API,
    call: { kind: 'operation', operation: 'ping', input: {} },
    settings: {},
    credentials: { apiKey: 'avito_token' },
    ...overrides,
  });
}

const okOutput =
  (output: unknown): Respond =>
  (frame, emit) => {
    if (frame.t === 'invoke') emit.frame({ t: 'result', ok: true, output });
  };

type InvokeFrame = Extract<HostFrame, { t: 'invoke' }>;
const framesOf = (sandboxes: { hostFrames: Map<string, HostFrame[]> }): HostFrame[] =>
  sandboxes.hostFrames.get('node-1') ?? [];
const invokeFrameOf = (sandboxes: { hostFrames: Map<string, HostFrame[]> }): InvokeFrame => {
  const frame = framesOf(sandboxes).find((item): item is InvokeFrame => item.t === 'invoke');
  if (!frame) throw new Error('кадр invoke не получен');
  return frame;
};

// Ждёт, пока фоновые шаги вызова (после await) зарегистрируют таймер или выставят значение.
async function until(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 1000; i += 1) {
    if (condition()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error('условие не наступило');
}

describe('invokeNode (orchestrator-core)', () => {
  const CHECKS: [string, NodeInvocation, NodeInvocationErrorCode][] = [
    ['node_type_not_found', invocation({ type: 'example/missing@1.0.0' }), 'node_type_not_found'],
    [
      'not_executable',
      invocation({ type: AGENT, call: { kind: 'execute', input: {} } }),
      'not_executable',
    ],
    [
      'invalid_call по виду вызова',
      invocation({ call: { kind: 'poll', cursor: null } }),
      'invalid_call',
    ],
    ['invalid_call по credentials', apiInvocation({ credentials: {} }), 'invalid_call'],
    [
      'unknown_operation',
      apiInvocation({ call: { kind: 'operation', operation: 'nope', input: {} } }),
      'unknown_operation',
    ],
    ['invalid_settings', invocation({ settings: { prefix: 1 } }), 'invalid_settings'],
    ['invalid_input', invocation({ call: { kind: 'execute', input: {} } }), 'invalid_input'],
    [
      'secret_missing',
      apiInvocation({ credentials: { apiKey: 'missing_secret' } }),
      'secret_missing',
    ],
  ];

  it.each(CHECKS)('AC-026-12: %s до песочницы', async (_name, input, code) => {
    const h = nodeHarness();
    const result = await h.invoke(input);
    expect(result).toMatchObject({ ok: false, error: { code } });
    expect(h.sandboxes.runs).toEqual([]);
  });

  it('AC-026-13: execute echo — результат после parse, песочница удалена, лог info node invoke', async () => {
    const h = nodeHarness({ respond: okOutput({ text: '> hi' }) });
    const result = await h.invoke(invocation());
    expect(result).toMatchObject({ ok: true, output: { text: '> hi' } });

    const frame = invokeFrameOf(h.sandboxes);
    expect(frame.settings).toEqual({ prefix: '> ' });
    expect(frame.secrets).toEqual({});
    expect(frame.egressProxy).toEqual({ url: 'http://egress-proxy:3128', token: 'token-1' });
    expect(frame.deadline).toBe(Date.parse(NOW) + 30000);
    expect(h.grants).toEqual([
      { invocationId: frame.invocationId, egress: [], expiresAt: Date.parse(NOW) + 30000 + 1000 },
    ]);
    expect(h.sandboxes.removed).toEqual(['node-1']);
    expect(h.log.entries).toContainEqual({
      level: 'info',
      msg: 'node invoke',
      ctx: expect.objectContaining({ ok: true, callKind: 'execute', code: null }),
    });
  });

  it('AC-026-13: operation — в invoke только секреты из credentials манифеста, грант с egress манифеста', async () => {
    const h = nodeHarness({ respond: okOutput({ ok: true }) });
    const result = await h.invoke(apiInvocation());
    expect(result).toMatchObject({ ok: true, output: { ok: true } });

    const frame = invokeFrameOf(h.sandboxes);
    expect(frame.secrets).toEqual({ apiKey: FAKE_SECRET });
    expect(JSON.stringify(frame)).not.toContain('fake-other-value');
    expect(h.grants[0]?.egress).toEqual(['api.example.com']);
  });

  it.each<[string, NodeInvocation, Respond, NodeInvocationErrorCode]>([
    ['выход не по схеме', invocation(), okOutput({ text: 5 }), 'invalid_output'],
    [
      'событие poll не по схеме',
      invocation({ type: TICK, call: { kind: 'poll', cursor: null }, settings: {} }),
      (frame, emit) => {
        if (frame.t === 'invoke')
          emit.frame({ t: 'result', ok: true, output: { events: [{}], cursor: null } });
      },
      'invalid_output',
    ],
    [
      'result с egress_denied',
      invocation(),
      (frame, emit) => {
        if (frame.t === 'invoke')
          emit.frame({ t: 'result', ok: false, code: 'egress_denied', message: 'закрыто' });
      },
      'egress_denied',
    ],
    [
      'result с неизвестным кодом',
      invocation(),
      (frame, emit) => {
        if (frame.t === 'invoke')
          emit.frame({ t: 'result', ok: false, code: 'weird', message: 'x' });
      },
      'protocol_error',
    ],
    [
      'строка не JSON',
      invocation(),
      (frame, emit) => {
        if (frame.t === 'invoke') emit.raw('не json');
      },
      'protocol_error',
    ],
    [
      'строка длиннее frameMaxBytes',
      invocation(),
      (frame, emit) => {
        if (frame.t === 'invoke') emit.frame({ t: 'log', level: 'info', msg: 'x'.repeat(2000) });
      },
      'protocol_error',
    ],
    [
      'конец потока без result',
      invocation(),
      (frame, emit) => {
        if (frame.t === 'invoke') emit.end();
      },
      'protocol_error',
    ],
  ])('AC-026-14: %s', async (_name, input, respond, code) => {
    const h = nodeHarness({ respond });
    const result = await h.invoke(input);
    expect(result).toMatchObject({ ok: false, error: { code } });
    expect(h.sandboxes.removed).toEqual(['node-1']);
  });

  it('AC-026-15: по deadline уходит abort, без result за грейс — timeout и удаление песочницы', async () => {
    const h = nodeHarness({ abortGraceMs: 1000 });
    const pending = h.invoke(invocation({ timeoutMs: 5000 }));
    await until(() => h.timers.has(5000));
    h.timers.fire(5000);
    expect(framesOf(h.sandboxes).map((frame) => frame.t)).toEqual(['invoke', 'abort']);
    await until(() => h.timers.has(1000));
    h.timers.fire(1000);

    const result = await pending;
    expect(result).toMatchObject({ ok: false, error: { code: 'timeout' } });
    expect(h.sandboxes.removed).toEqual(['node-1']);
  });

  it('AC-026-15: result, пришедший в пределах грейса, возвращается как есть', async () => {
    const h = nodeHarness({
      abortGraceMs: 1000,
      respond: (frame, emit) => {
        if (frame.t === 'invoke') return;
        if (frame.t === 'abort') emit.frame({ t: 'result', ok: true, output: { text: '> hi' } });
      },
    });
    const pending = h.invoke(invocation({ timeoutMs: 5000 }));
    await until(() => h.timers.has(5000));
    h.timers.fire(5000);

    expect(await pending).toMatchObject({ ok: true, output: { text: '> hi' } });
    expect(h.sandboxes.removed).toEqual(['node-1']);
  });

  it('AC-026-16: значения секретов в msg, data и error.message заменяются на [secret]', async () => {
    const h = nodeHarness({
      respond: (frame, emit) => {
        if (frame.t !== 'invoke') return;
        emit.frame({
          t: 'log',
          level: 'info',
          msg: `token ${FAKE_SECRET} ok`,
          data: { nested: [FAKE_SECRET], s: FAKE_SECRET },
        });
        emit.frame({
          t: 'result',
          ok: false,
          code: 'node_failed',
          message: `failed with ${FAKE_SECRET}`,
        });
      },
    });
    const result = await h.invoke(apiInvocation());
    expect(result).toMatchObject({
      ok: false,
      error: { code: 'node_failed', message: 'failed with [secret]' },
    });
    expect(h.log.entries).toContainEqual({
      level: 'info',
      msg: 'node log',
      ctx: expect.objectContaining({
        msg: 'token [secret] ok',
        data: { nested: ['[secret]'], s: '[secret]' },
      }),
    });
    expect(JSON.stringify(h.log.entries)).not.toContain(FAKE_SECRET);
  });

  it('AC-026-16: после 200 кадров log новые не пишутся, warn node log limit записан один раз', async () => {
    const h = nodeHarness({
      respond: (frame, emit) => {
        if (frame.t !== 'invoke') return;
        for (let i = 0; i < 201; i += 1) emit.frame({ t: 'log', level: 'info', msg: `m${i}` });
        emit.frame({ t: 'result', ok: true, output: { text: 'done' } });
      },
    });
    await h.invoke(invocation());
    expect(h.log.entries.filter((entry) => entry.msg === 'node log')).toHaveLength(200);
    expect(
      h.log.entries.filter((entry) => entry.level === 'warn' && entry.msg === 'node log limit'),
    ).toHaveLength(1);
  });

  it('AC-026-16: msg обрезается до 1000 символов, data больше 8192 байт заменяется на { truncated: true }', async () => {
    const h = nodeHarness({
      frameMaxBytes: 20000,
      respond: (frame, emit) => {
        if (frame.t !== 'invoke') return;
        emit.frame({
          t: 'log',
          level: 'info',
          msg: 'a'.repeat(1500),
          data: { big: 'b'.repeat(9000) },
        });
        emit.frame({ t: 'result', ok: true, output: { text: 'done' } });
      },
    });
    await h.invoke(invocation());
    const entry = h.log.entries.find((item) => item.msg === 'node log');
    expect(entry?.ctx).toMatchObject({ msg: 'a'.repeat(1000), data: { truncated: true } });
  });

  it('AC-026-17: state.set/get/удаление, длинные ключ и значение отклоняются кадром state с error', async () => {
    const h = nodeHarness({
      frameMaxBytes: 100000,
      respond: (frame, emit) => {
        if (frame.t !== 'invoke') return;
        emit.frame({ t: 'state.set', id: 1, key: 'k', value: 'v' });
        emit.frame({ t: 'state.get', id: 2, key: 'k' });
        emit.frame({ t: 'state.set', id: 3, key: 'k', value: null });
        emit.frame({ t: 'state.get', id: 4, key: 'k' });
        emit.frame({ t: 'state.set', id: 5, key: 'x'.repeat(201), value: 'v' });
        emit.frame({ t: 'state.set', id: 6, key: 'big', value: 'x'.repeat(65537) });
        emit.frame({ t: 'result', ok: true, output: { text: 'done' } });
      },
    });
    const result = await h.invoke(invocation());
    expect(result).toMatchObject({ ok: true });

    const replies = framesOf(h.sandboxes).filter((frame) => frame.t === 'state');
    expect(replies).toEqual([
      { t: 'state', id: 1, value: null },
      { t: 'state', id: 2, value: 'v' },
      { t: 'state', id: 3, value: null },
      { t: 'state', id: 4, value: null },
      { t: 'state', id: 5, error: expect.any(String) },
      { t: 'state', id: 6, error: expect.any(String) },
    ]);
    expect(h.stateSets).toEqual([
      { orgId: ORG, stateKey: 'node-1', key: 'k', value: 'v' },
      { orgId: ORG, stateKey: 'node-1', key: 'k', value: null },
    ]);
    expect(h.stateValues.size).toBe(0);
  });

  it('AC-026-23: cleanupOrphans удаляет обе песочницы swag.kind=node и не трогает чужие', async () => {
    const h = nodeHarness();
    h.sandboxes.seed('node-old-1', { 'swag.kind': 'node' });
    h.sandboxes.seed('node-old-2', { 'swag.kind': 'node' });
    const core = createOrchestratorCore({
      ...h.nodeDeps,
      version: 'test',
      clock: h.deps.clock,
      ids: h.deps.ids,
      timers: h.deps.timers,
      log: h.deps.log,
      sandboxes: {
        create: async () => ({ sandboxId: 'agent-x' }),
        remove: async () => undefined,
        list: async () => [],
      },
      bus: { publishEvent: async () => undefined, publishMessage: async () => undefined },
      llmSwarms: { register: async () => undefined, close: async () => null },
      trace: { currentTraceId: () => null },
      agent: {
        template: 'swag-agent:test',
        maxSteps: 1,
        maxTokens: 1,
        llmGatewayToken: 'fake-gateway-token-000000000000000000',
        flushTimeoutMs: 1000,
      },
      timeouts: { agentStartMs: 1000, swarmMs: 1000 },
    });
    expect(await core.cleanupOrphans()).toBe(2);
    expect([...h.sandboxes.removed].sort()).toEqual(['node-old-1', 'node-old-2']);
  });
});
