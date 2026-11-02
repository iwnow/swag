import { describe, expect, it } from 'vitest';
import {
  HostFrame,
  NodeErrorCode,
  NodeCall,
  NodeInvocation,
  NodeInvocationErrorCode,
  NodeInvocationResult,
  SandboxFrame,
  SecretName,
  egressMatches,
} from '../src/index.ts';

const ORG_ID = '0b6f6d2e-6a4c-4c3e-9f5e-222222222222';
const INVOCATION_ID = '0b6f6d2e-6a4c-4c3e-9f5e-333333333333';
const EGRESS = ['api.example.com', '*.cdn.example.com', 'x.example.com:8443'];

describe('egressMatches', () => {
  it('AC-026-1: сверка хоста и порта с egress', () => {
    expect(egressMatches(EGRESS, 'api.example.com', 443)).toBe(true);
    expect(egressMatches(EGRESS, 'a.b.cdn.example.com', 443)).toBe(true);
    expect(egressMatches(EGRESS, 'cdn.example.com', 443)).toBe(false);
    expect(egressMatches(EGRESS, 'api.example.com', 8443)).toBe(false);
    expect(egressMatches(EGRESS, 'x.example.com', 8443)).toBe(true);
    expect(egressMatches(EGRESS, 'x.example.com', 443)).toBe(false);
  });

  it('AC-026-1: суффикс с "*." не совпадает с хостом, который лишь заканчивается на то же слово', () => {
    expect(egressMatches(['*.example.com'], 'evilexample.com', 443)).toBe(false);
  });

  it('egressMatches: краевые случаи', () => {
    expect(egressMatches(['*.a.com:8443'], 'x.a.com', 8443)).toBe(true);
    expect(egressMatches(['*.a.com:8443'], 'x.a.com', 443)).toBe(false);
    expect(egressMatches(['*.a.com'], 'a.com', 443)).toBe(false);
    expect(egressMatches(['api.example.com'], 'api.example.com.', 443)).toBe(false);
    expect(egressMatches(['api.example.com'], '::1', 443)).toBe(false);
    expect(egressMatches(['api.example.com'], 'api.example.com', 0)).toBe(false);
  });
});

const SCHEMA_CALL = { kind: 'execute', input: { q: 1 } };

describe('node-invocation schemas', () => {
  it('NodeInvocation принимает корректный вызов и отвергает лишнее поле', () => {
    const valid = {
      orgId: ORG_ID,
      type: 'example/echo@1.0.0',
      call: SCHEMA_CALL,
      settings: {},
      credentials: { apiKey: 'openai_key' },
      stateKey: 'node-1',
    };
    expect(NodeInvocation.safeParse(valid).success).toBe(true);
    expect(NodeInvocation.safeParse({ ...valid, image: 'node:24' }).success).toBe(false);
  });

  it('NodeCall отвергает неизвестный kind', () => {
    expect(NodeCall.safeParse({ kind: 'stream', input: 1 }).success).toBe(false);
  });

  it('SecretName принимает openai_key и отвергает Bad и строку длиной 65', () => {
    expect(SecretName.safeParse('openai_key').success).toBe(true);
    expect(SecretName.safeParse('Bad').success).toBe(false);
    expect(SecretName.safeParse('a'.repeat(65)).success).toBe(false);
  });

  it('NodeInvocationResult принимает успех и ошибку', () => {
    expect(
      NodeInvocationResult.safeParse({ ok: true, output: { a: 1 }, durationMs: 12 }).success,
    ).toBe(true);
    expect(
      NodeInvocationResult.safeParse({
        ok: false,
        error: { code: 'timeout', message: 'истекло время' },
        durationMs: 30_000,
      }).success,
    ).toBe(true);
  });

  it('HostFrame принимает invoke, оба варианта state и abort, отвергает state с value и error сразу', () => {
    const invoke = {
      t: 'invoke',
      invocationId: INVOCATION_ID,
      package: '@swag/node-example',
      definition: { type: 'example/echo', version: '1.0.0' },
      call: { kind: 'poll', cursor: null },
      settings: {},
      secrets: { apiKey: 'fake-secret-value' },
      egressProxy: { url: 'http://egress-proxy:3128', token: 'fake-token' },
      deadline: 1_800_000_000_000,
    };
    expect(HostFrame.safeParse(invoke).success).toBe(true);
    expect(HostFrame.safeParse({ ...invoke, extra: 1 }).success).toBe(false);
    expect(HostFrame.safeParse({ t: 'state', id: 1, value: 'x' }).success).toBe(true);
    expect(HostFrame.safeParse({ t: 'state', id: 1, error: 'boom' }).success).toBe(true);
    expect(HostFrame.safeParse({ t: 'state', id: 1, value: 'x', error: 'boom' }).success).toBe(
      false,
    );
    expect(HostFrame.safeParse({ t: 'abort' }).success).toBe(true);
  });

  it('SandboxFrame принимает log, state.get, state.set, оба result и отвергает неизвестный код', () => {
    expect(
      SandboxFrame.safeParse({ t: 'log', level: 'info', msg: 'ok', data: { a: 1 } }).success,
    ).toBe(true);
    expect(SandboxFrame.safeParse({ t: 'state.get', id: 1, key: 'cursor' }).success).toBe(true);
    expect(
      SandboxFrame.safeParse({ t: 'state.set', id: 2, key: 'cursor', value: null }).success,
    ).toBe(true);
    expect(SandboxFrame.safeParse({ t: 'result', ok: true, output: null }).success).toBe(true);
    expect(
      SandboxFrame.safeParse({
        t: 'result',
        ok: false,
        code: 'node_failed',
        message: 'упал',
      }).success,
    ).toBe(true);
    expect(
      SandboxFrame.safeParse({ t: 'result', ok: false, code: 'timeout', message: 'x' }).success,
    ).toBe(false);
  });

  it('каждый NodeErrorCode входит в NodeInvocationErrorCode', () => {
    for (const code of NodeErrorCode.options) {
      expect(NodeInvocationErrorCode.options, code).toContain(code);
    }
  });
});
