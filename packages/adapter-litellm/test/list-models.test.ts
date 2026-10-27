import { afterEach, describe, expect, it } from 'vitest';
import { startFakeProvider } from '../../../infra/llm/fake-provider/server.ts';
import { createLiteLlmUpstream } from '../src/index.ts';

// Спека 002, 4.4 и 4.5: listModels — GET {baseUrl}/v1/models, результат — ids.
const MASTER_KEY = 'sk-swag-local-not-secret';

const signal = () => new AbortController().signal;

const upstreamFor = (baseUrl: string, fetchImpl: typeof fetch = fetch) =>
  createLiteLlmUpstream({
    baseUrl,
    masterKey: MASTER_KEY,
    idleTimeoutMs: 120_000,
    secrets: [MASTER_KEY],
    fetch: fetchImpl,
  });

// Подставной fetch для ответов, которые фейк не даёт.
const replying = (res: Response): typeof fetch => (async () => res) as typeof fetch;

let closeFake: (() => Promise<void>) | undefined;

afterEach(async () => {
  await closeFake?.();
  closeFake = undefined;
});

describe('listModels (спека 002, 4.5)', () => {
  it('фейк отдаёт id по умолчанию: chat-small и chat-large', async () => {
    const fake = await startFakeProvider({ port: 0 });
    closeFake = fake.close;

    const result = await upstreamFor(fake.url).listModels(signal());

    expect(result).toEqual({ ok: true, ids: ['chat-small', 'chat-large'] });
  });

  it('фейк с opts.models отдаёт свой список', async () => {
    const fake = await startFakeProvider({ port: 0, models: ['only-one'] });
    closeFake = fake.close;

    const result = await upstreamFor(fake.url).listModels(signal());

    expect(result).toEqual({ ok: true, ids: ['only-one'] });
  });

  it('запрос — GET {baseUrl}/v1/models с Authorization мастер-ключа', async () => {
    const seen: { url: string; method: string | undefined; auth: string | null }[] = [];
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      seen.push({
        url,
        method: init?.method,
        auth: new Headers(init?.headers).get('authorization'),
      });
      return Response.json({ data: [{ id: 'a' }] });
    }) as typeof fetch;

    await upstreamFor('http://stub.invalid', fetchImpl).listModels(signal());

    expect(seen).toEqual([
      { url: 'http://stub.invalid/v1/models', method: 'GET', auth: `Bearer ${MASTER_KEY}` },
    ]);
  });

  it('не-2xx — http с error.message, секрет заменён на ***', async () => {
    const result = await upstreamFor(
      'http://stub.invalid',
      replying(Response.json({ error: { message: `нет доступа ${MASTER_KEY}` } }, { status: 401 })),
    ).listModels(signal());

    expect(result).toEqual({
      ok: false,
      failure: { kind: 'http', status: 401, message: 'нет доступа ***' },
    });
  });

  it('D-50: 2xx без JSON — network', async () => {
    const result = await upstreamFor(
      'http://stub.invalid',
      replying(new Response('не json', { status: 200 })),
    ).listModels(signal());

    expect(result).toEqual({ ok: false, failure: { kind: 'network' } });
  });

  it('D-50: 2xx без формы { data: [{ id }] } — network', async () => {
    const bodies = [{ models: [] }, { data: [{ name: 'x' }] }];

    for (const body of bodies) {
      const result = await upstreamFor(
        'http://stub.invalid',
        replying(Response.json(body)),
      ).listModels(signal());

      expect(result).toEqual({ ok: false, failure: { kind: 'network' } });
    }
  });
});
