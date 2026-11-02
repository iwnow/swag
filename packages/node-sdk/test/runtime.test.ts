import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { defineNode, NodeError } from '../src/index.ts';
import { invokeNode, parseSettings } from '../src/runtime.ts';
import { createTestContext, runNode, runOperation, runPoll, runSend } from '../src/testing.ts';
import { chat, crm, echo } from './fixtures.ts';

// Спека 026, 4.3 (REQ-026-15). Триггер для проверки вида trigger; в фикстурах 021 его нет.
const clock = defineNode({
  type: 'example/clock',
  version: '1.0.0',
  kind: 'trigger',
  title: 'Часы',
  description: 'Фикстура триггера.',
  settings: z.strictObject({}),
  outputs: z.strictObject({ at: z.string() }),
  poll: async (cursor) => ({ events: [{ at: cursor ?? 'start' }], cursor: 'next' }),
});

const crmContext = () =>
  createTestContext(crm, {
    settings: {},
    secrets: { apiKey: 'test-key' },
    fetch: async () => new Response(null, { status: 200 }),
  });

const crmInput = { secret: 'apiKey', url: 'https://api.example.com/items' };

describe('invokeNode', () => {
  it('AC-026-3: execute у программы даёт тот же выход, что runNode', async () => {
    const viaRuntime = await invokeNode(
      echo,
      { kind: 'execute', input: { text: 'hi' } },
      createTestContext(echo, { settings: { prefix: '> ' } }),
    );
    const viaTesting = await runNode(
      echo,
      createTestContext(echo, { settings: { prefix: '> ' } }),
      { text: 'hi' },
    );

    expect(viaRuntime).toEqual({ text: '> hi' });
    expect(viaRuntime).toEqual(viaTesting);
  });

  it('AC-026-3: operation у коннектора даёт тот же выход, что runOperation', async () => {
    const viaRuntime = await invokeNode(
      crm,
      { kind: 'operation', operation: 'call', input: crmInput },
      crmContext(),
    );
    const viaTesting = await runOperation(crm, 'call', crmContext(), crmInput);

    expect(viaRuntime).toEqual({ key: 'test-key', status: 200 });
    expect(viaRuntime).toEqual(viaTesting);
  });

  it('AC-026-3: poll у канала и триггера даёт тот же результат, что runPoll', async () => {
    const channelRuntime = await invokeNode(
      chat,
      { kind: 'poll', cursor: null },
      createTestContext(chat, { settings: {} }),
    );
    const clockRuntime = await invokeNode(
      clock,
      { kind: 'poll', cursor: 'c1' },
      createTestContext(clock, { settings: {} }),
    );

    expect(channelRuntime).toEqual(
      await runPoll(chat, createTestContext(chat, { settings: {} }), null),
    );
    expect(clockRuntime).toEqual(
      await runPoll(clock, createTestContext(clock, { settings: {} }), 'c1'),
    );
    expect(clockRuntime).toEqual({ events: [{ at: 'c1' }], cursor: 'next' });
  });

  it('AC-026-3: send у канала даёт null и тот же эффект, что runSend', async () => {
    const ctx = createTestContext(chat, { settings: {} });
    const result = await invokeNode(chat, { kind: 'send', message: { text: 'привет' } }, ctx);

    expect(result).toBeNull();
    expect(ctx.stateSnapshot()).toEqual({ sent: 'привет' });

    const viaTesting = createTestContext(chat, { settings: {} });
    await runSend(chat, viaTesting, { text: 'привет' });
    expect(viaTesting.stateSnapshot()).toEqual(ctx.stateSnapshot());
  });

  it('AC-026-3: вход и выход проверяются схемами, как в runNode', async () => {
    await expect(
      invokeNode(
        echo,
        { kind: 'execute', input: { text: 1 } },
        createTestContext(echo, { settings: {} }),
      ),
    ).rejects.toMatchObject({ code: 'invalid_input' });
  });

  it('AC-026-3: неподходящий вид вызова — unknown_operation', async () => {
    const programCtx = createTestContext(echo, { settings: {} });
    await expect(
      invokeNode(echo, { kind: 'operation', operation: 'call', input: {} }, programCtx),
    ).rejects.toMatchObject({ code: 'unknown_operation' });

    await expect(
      invokeNode(clock, { kind: 'send', message: {} }, createTestContext(clock, { settings: {} })),
    ).rejects.toMatchObject({ code: 'unknown_operation' });

    await expect(
      invokeNode(crm, { kind: 'operation', operation: 'missing', input: {} }, crmContext()),
    ).rejects.toMatchObject({ code: 'unknown_operation' });
  });
});

describe('parseSettings', () => {
  it('AC-026-3: верные настройки возвращаются после parse, неверные — invalid_settings', () => {
    expect(parseSettings(echo, {})).toEqual({ prefix: '' });
    expect(parseSettings(echo, { prefix: '> ' })).toEqual({ prefix: '> ' });

    let caught: unknown;
    try {
      parseSettings(echo, { prefix: 1 });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(NodeError);
    expect(caught).toMatchObject({ code: 'invalid_settings' });
  });
});
