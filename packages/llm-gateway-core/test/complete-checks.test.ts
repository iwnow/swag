import { describe, expect, it } from 'vitest';
import { createLlmGatewayCore } from '../src/index.ts';
import { fakeDeps } from './fakes.ts';

// Спека 002, 4.2 (проверки 2–4), 4.4 (шаги до upstream), 4.6. Отказы до LiteLLM: upstream не вызван, событий нет.

const signal = { aborted: false };
const SWARM_ID = '6f1c2a4e-8b3d-4e5f-9a1b-2c3d4e5f6a7b';
const caller = { swarmId: SWARM_ID, agentId: 'agent-1' };
const body = { model: 'chat-small', messages: [{ role: 'user', content: 'привет' }] };

const CALLER_MESSAGE = 'Missing or invalid x-swag-swarm-id / x-swag-agent-id';

// Вызывает complete с заведомо неудачным входом и проверяет, что до апстрима и шины дело не дошло.
async function refuse(rawCaller: { swarmId?: string; agentId?: string }, rawBody: unknown) {
  const { deps, upstream, events } = fakeDeps();
  const result = await createLlmGatewayCore(deps).complete(rawCaller, rawBody, signal);
  expect(upstream.calls).toEqual([]);
  expect(events.published).toEqual([]);
  if (result.kind !== 'error') throw new Error(`ожидался отказ, пришло: ${result.kind}`);
  return result;
}

describe('complete: проверка вызывающего (LlmCaller)', () => {
  it.each([
    ['нет x-swag-swarm-id', { agentId: 'agent-1' }],
    ['x-swag-swarm-id не UUID', { swarmId: 'swarm-1', agentId: 'agent-1' }],
    ['x-swag-agent-id равен bob', { swarmId: SWARM_ID, agentId: 'bob' }],
    ['нет x-swag-agent-id', { swarmId: SWARM_ID }],
  ])('AC-002-3: %s — 400 invalid_caller, апстрим не вызван, событий нет', async (_, rawCaller) => {
    expect(await refuse(rawCaller, body)).toEqual({
      kind: 'error',
      status: 400,
      error: { message: CALLER_MESSAGE, code: 'invalid_caller' },
    });
  });

  it('AC-002-3: неверный вызывающий проверяется раньше тела', async () => {
    const result = await refuse({ agentId: 'agent-1' }, { messages: [] });
    expect(result.error.code).toBe('invalid_caller');
  });
});

describe('complete: проверка тела (ChatRequest)', () => {
  it.each([
    ['тело без messages', { model: 'chat-small' }],
    ['messages: []', { model: 'chat-small', messages: [] }],
    ['тело-массив', [{ model: 'chat-small', messages: [{ role: 'user' }] }]],
  ])('AC-002-5: %s — 400 invalid_request, апстрим не вызван, событий нет', async (_, rawBody) => {
    const result = await refuse(caller, rawBody);
    expect(result).toMatchObject({
      kind: 'error',
      status: 400,
      error: { code: 'invalid_request' },
    });
  });

  it.each(['api_key', 'api_base', 'extra_headers'])(
    'AC-002-28: поле %s в теле — 400 invalid_request с именем поля в message',
    async (field) => {
      expect(await refuse(caller, { ...body, [field]: 'sk-x' })).toEqual({
        kind: 'error',
        status: 400,
        error: {
          message: `Client-side provider credentials are not allowed: ${field}`,
          code: 'invalid_request',
        },
      });
    },
  );

  it('AC-002-5: неверное тело проверяется раньше модели', async () => {
    const result = await refuse(caller, { model: 'gpt-unknown', messages: [] });
    expect(result.error.code).toBe('invalid_request');
  });
});

describe('complete: модель в каталоге', () => {
  it('AC-002-4: модели нет в каталоге — 400 model_not_found с именем модели', async () => {
    expect(await refuse(caller, { ...body, model: 'gpt-unknown' })).toEqual({
      kind: 'error',
      status: 400,
      error: { message: 'Unknown model: gpt-unknown', code: 'model_not_found' },
    });
  });

  it('AC-002-4: имя модели в message обрезается до 100 символов', async () => {
    const longName = 'x'.repeat(150);
    const result = await refuse(caller, { ...body, model: longName });
    expect(result.error).toEqual({
      message: `Unknown model: ${'x'.repeat(100)}`,
      code: 'model_not_found',
    });
  });

  it('AC-002-4: обрезка идёт по символам, а не по UTF-16 кодовым единицам (эмодзи не режется)', async () => {
    const result = await refuse(caller, { ...body, model: '😀'.repeat(101) });
    expect(result.error.message).toBe(`Unknown model: ${'😀'.repeat(100)}`);
  });
});
