import { describe, expect, it } from 'vitest';
import type { NodeInvocation, NodeInvocationResult } from '@swag/contracts';
import { buildApp } from '../src/app.ts';
import { makeCore, TOKEN } from './support.ts';

const MARKER = 'node-body-marker-7f3a9c';
const INVOCATION = {
  orgId: '0b6f6d2e-6a4c-4c3e-9f5e-444444444444',
  type: 'example/echo@1.0.0',
  call: { kind: 'execute', input: { text: MARKER } },
  settings: { prefix: '> ' },
  credentials: {},
  stateKey: 'node-1',
};
const RESULT: NodeInvocationResult = {
  ok: true,
  output: { text: '> hi' },
  durationMs: 3,
};

function setup() {
  const received: NodeInvocation[] = [];
  const core = {
    ...makeCore(new Map()),
    invokeNode: async (invocation: NodeInvocation) => {
      received.push(invocation);
      return RESULT;
    },
  };
  const lines: string[] = [];
  const app = buildApp(
    core,
    { logger: { level: 'info', stream: { write: (line: string) => void lines.push(line) } } },
    { token: TOKEN },
  );
  return { app, received, lines };
}

describe('POST /node-invocations (спека 026, 4.10)', () => {
  it('AC-026-21: без токена — 401, ядро не вызвано', async () => {
    const { app, received } = setup();
    const response = await app.inject({
      method: 'POST',
      url: '/node-invocations',
      payload: INVOCATION,
    });
    expect(response.statusCode).toBe(401);
    expect(received).toHaveLength(0);
    await app.close();
  });

  it('AC-026-21: с неверным телом — 400 invalid_request, ядро не вызвано', async () => {
    const { app, received } = setup();
    const response = await app.inject({
      method: 'POST',
      url: '/node-invocations',
      headers: { authorization: `Bearer ${TOKEN}` },
      payload: { call: { kind: 'execute', input: { text: MARKER } } },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      error: { code: 'invalid_request', message: 'Body is not a NodeInvocation' },
    });
    expect(received).toHaveLength(0);
    await app.close();
  });

  it('AC-026-21: тело не JSON — 400 validation_error, ядро не вызвано', async () => {
    const { app, received } = setup();
    const response = await app.inject({
      method: 'POST',
      url: '/node-invocations',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      payload: '{not json',
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('validation_error');
    expect(received).toHaveLength(0);
    await app.close();
  });

  it('AC-026-21: с верным телом — 200 с результатом ядра, тело доходит до ядра', async () => {
    const { app, received } = setup();
    const response = await app.inject({
      method: 'POST',
      url: '/node-invocations',
      headers: { authorization: `Bearer ${TOKEN}` },
      payload: INVOCATION,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(RESULT);
    expect(received).toEqual([INVOCATION]);
    await app.close();
  });

  it('AC-026-21: тело запроса не попадает в лог', async () => {
    const { app, lines } = setup();
    await app.inject({
      method: 'POST',
      url: '/node-invocations',
      headers: { authorization: `Bearer ${TOKEN}` },
      payload: INVOCATION,
    });
    await app.inject({
      method: 'POST',
      url: '/node-invocations',
      headers: { authorization: `Bearer ${TOKEN}` },
      payload: { call: { kind: 'execute', input: { text: MARKER } } },
    });
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.join('\n')).not.toContain(MARKER);
    await app.close();
  });
});
