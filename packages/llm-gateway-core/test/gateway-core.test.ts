import { describe, expect, it } from 'vitest';
import { createLlmGatewayCore } from '../src/index.ts';
import { fakeDeps } from './fakes.ts';

// Спека 002, 4.4: фабрика ядра. Тесты без AC-id — на info и на заглушку complete (T-14…T-18 её заменят).

const signal = { aborted: false };

describe('фабрика ядра', () => {
  it('info: сервис llm-gateway и версия из deps', () => {
    const { deps } = fakeDeps();
    expect(createLlmGatewayCore(deps).info()).toEqual({ service: 'llm-gateway', version: 'test' });
  });
});

describe('listModels', () => {
  it('AC-002-6: модели каталога в его порядке, owned_by swag; апстрим не вызывается', () => {
    const { deps, upstream } = fakeDeps();
    expect(createLlmGatewayCore(deps).listModels()).toEqual({
      object: 'list',
      data: [
        { id: 'chat-small', object: 'model', owned_by: 'swag' },
        { id: 'chat-large', object: 'model', owned_by: 'swag' },
      ],
    });
    expect(upstream.calls).toEqual([]);
  });
});

describe('checkUpstream', () => {
  it('AC-002-18: все модели каталога есть у апстрима — ok, лишние id апстрима не мешают', async () => {
    const { deps, upstream } = fakeDeps({
      upstream: { models: { ok: true, ids: ['chat-small', 'chat-large', 'other'] } },
    });
    expect(await createLlmGatewayCore(deps).checkUpstream(signal)).toEqual({ ok: true });
    expect(upstream.calls).toEqual([{ op: 'listModels' }]);
  });

  it('AC-002-18: нет chat-large у апстрима — missing: [chat-large]', async () => {
    const { deps } = fakeDeps({ upstream: { models: { ok: true, ids: ['chat-small'] } } });
    expect(await createLlmGatewayCore(deps).checkUpstream(signal)).toEqual({
      ok: false,
      missing: ['chat-large'],
    });
  });

  it('AC-002-18: ошибка апстрима — failure как есть, без missing', async () => {
    const failure = { kind: 'http', status: 503, message: 'HTTP 503' } as const;
    const { deps } = fakeDeps({ upstream: { models: { ok: false, failure } } });
    expect(await createLlmGatewayCore(deps).checkUpstream(signal)).toEqual({ ok: false, failure });
  });
});
