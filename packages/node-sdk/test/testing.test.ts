import { afterEach, describe, expect, it, vi } from 'vitest';
import { NodeError } from '../src/index.ts';
import { createTestContext, runNode, runOperation, runPoll, runSend } from '../src/testing.ts';
import { badChat, chat, crm, echo, wrongOutput } from './fixtures.ts';

// Код ошибки NodeError из синхронного вызова.
function errorCode(fn: () => unknown): unknown {
  try {
    fn();
  } catch (err) {
    return err instanceof NodeError ? err.code : err;
  }
  throw new Error('ошибка не брошена');
}

// Код ошибки NodeError из отклонённого промиса.
async function rejectionCode(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (err) {
    return err instanceof NodeError ? err.code : err;
  }
  throw new Error('промис не отклонён');
}

const okFetch = () => Promise.resolve(new Response(null, { status: 200 }));

afterEach(() => {
  vi.restoreAllMocks();
});

describe('тестовая обвязка узла (021, 4.3)', () => {
  it('AC-021-11: runNode возвращает выход с префиксом из настроек', async () => {
    const ctx = createTestContext(echo, { settings: { prefix: '> ' } });
    await expect(runNode(echo, ctx, { text: 'hi' })).resolves.toEqual({ text: '> hi' });
  });

  it('AC-021-11: вход не по схеме — invalid_input, execute не вызван', async () => {
    const execute = vi.spyOn(echo, 'execute');
    const ctx = createTestContext(echo, { settings: { prefix: '> ' } });
    expect(await rejectionCode(runNode(echo, ctx, { text: 1 }))).toBe('invalid_input');
    expect(execute).not.toHaveBeenCalled();
  });

  it('AC-021-11: настройки не по схеме — createTestContext бросает invalid_settings', () => {
    expect(errorCode(() => createTestContext(echo, { settings: { prefix: 1 } }))).toBe(
      'invalid_settings',
    );
  });

  it('AC-021-12: выход программы не по схеме — invalid_output', async () => {
    const ctx = createTestContext(wrongOutput, { settings: {} });
    expect(await rejectionCode(runNode(wrongOutput, ctx, { text: 'a' }))).toBe('invalid_output');
  });

  it('AC-021-13: секреты — только объявленные и переданные', async () => {
    const ctx = createTestContext(crm, { settings: {}, secrets: { apiKey: 'fake-key' } });
    const url = 'https://api.example.com/x';
    await expect(runOperation(crm, 'call', ctx, { secret: 'apiKey', url })).resolves.toEqual({
      key: 'fake-key',
      status: 501,
    });
    expect(await rejectionCode(runOperation(crm, 'call', ctx, { secret: 'other', url }))).toBe(
      'secret_not_declared',
    );
    const noValue = createTestContext(crm, { settings: {} });
    expect(await rejectionCode(runOperation(crm, 'call', noValue, { secret: 'apiKey', url }))).toBe(
      'secret_not_declared',
    );
  });

  it('AC-021-13: http.fetch по правилам egress вызывает options.fetch', async () => {
    const fetch = vi.fn(okFetch);
    const ctx = createTestContext(crm, { settings: {}, secrets: { apiKey: 'fake-key' }, fetch });
    const urls = [
      'https://api.example.com/x',
      'https://a.cdn.example.com/x',
      'https://a.b.cdn.example.com/x',
    ];
    for (const url of urls) {
      await expect(
        runOperation(crm, 'call', ctx, { secret: 'apiKey', url }),
      ).resolves.toMatchObject({ status: 200 });
    }
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it('AC-021-13: адреса вне egress — egress_denied без вызова options.fetch', async () => {
    const fetch = vi.fn(okFetch);
    const ctx = createTestContext(crm, { settings: {}, secrets: { apiKey: 'fake-key' }, fetch });
    const denied = [
      'https://cdn.example.com/x',
      'https://evil.com/x',
      'http://api.example.com/x',
      'https://api.example.com:8443/x',
      'https://api.example.com@evil.com/x',
    ];
    for (const url of denied) {
      expect(await rejectionCode(runOperation(crm, 'call', ctx, { secret: 'apiKey', url }))).toBe(
        'egress_denied',
      );
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it('AC-021-13: runOperation с неизвестным именем — unknown_operation', async () => {
    const ctx = createTestContext(crm, { settings: {} });
    expect(await rejectionCode(runOperation(crm, 'missing', ctx, {}))).toBe('unknown_operation');
  });

  it('AC-021-14: runPoll отдаёт верные события и состояние из poll', async () => {
    const ctx = createTestContext(chat, { settings: {} });
    await expect(runPoll(chat, ctx, null)).resolves.toEqual({
      events: [{ text: 'hi' }],
      cursor: 'next',
    });
    expect(ctx.stateSnapshot()).toEqual({ seen: 'yes' });
  });

  it('AC-021-14: событие poll не по outputs — invalid_output', async () => {
    const ctx = createTestContext(badChat, { settings: {} });
    expect(await rejectionCode(runPoll(badChat, ctx, null))).toBe('invalid_output');
  });

  it('AC-021-14: runSend с верным сообщением проходит и попадает в состояние', async () => {
    const ctx = createTestContext(chat, { settings: {} });
    await runSend(chat, ctx, { text: 'a' });
    expect(ctx.stateSnapshot()).toEqual({ sent: 'a' });
  });

  it('AC-021-14: runSend с сообщением не по inputs — invalid_input, send не вызван', async () => {
    const send = vi.spyOn(chat, 'send');
    const ctx = createTestContext(chat, { settings: {} });
    expect(await rejectionCode(runSend(chat, ctx, { text: 1 }))).toBe('invalid_input');
    expect(send).not.toHaveBeenCalled();
    expect(ctx.stateSnapshot()).toEqual({});
  });
});
