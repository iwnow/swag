import { describe, expect, it } from 'vitest';
import { MASTER_KEY, STUB_URL, signal, stubFetch, upstreamFor, useFake } from './helpers.ts';

// Спека 002, 4.4 и 4.5: listModels — GET {baseUrl}/v1/models, результат — ids.

describe('listModels на фейке (спека 002, 4.5)', () => {
  const fake = useFake();

  it('фейк отдаёт id по умолчанию: chat-small и chat-large', async () => {
    const result = await upstreamFor(fake.current.url).listModels(signal());

    expect(result).toEqual({ ok: true, ids: ['chat-small', 'chat-large'] });
  });
});

describe('listModels на фейке с opts.models (спека 002, 4.5)', () => {
  const fake = useFake(['only-one']);

  it('фейк с opts.models отдаёт свой список', async () => {
    const result = await upstreamFor(fake.current.url).listModels(signal());

    expect(result).toEqual({ ok: true, ids: ['only-one'] });
  });
});

describe('listModels (спека 002, 4.5)', () => {
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

    await upstreamFor(STUB_URL, { fetch: fetchImpl }).listModels(signal());

    expect(seen).toEqual([
      { url: `${STUB_URL}/v1/models`, method: 'GET', auth: `Bearer ${MASTER_KEY}` },
    ]);
  });

  it('не-2xx — http с error.message, секрет заменён на ***', async () => {
    const result = await upstreamFor(STUB_URL, {
      fetch: stubFetch(
        Response.json({ error: { message: `нет доступа ${MASTER_KEY}` } }, { status: 401 }),
      ),
    }).listModels(signal());

    expect(result).toEqual({
      ok: false,
      failure: { kind: 'http', status: 401, message: 'нет доступа ***' },
    });
  });

  it('D-50: 2xx без JSON — network', async () => {
    const result = await upstreamFor(STUB_URL, {
      fetch: stubFetch(new Response('не json', { status: 200 })),
    }).listModels(signal());

    expect(result).toEqual({ ok: false, failure: { kind: 'network' } });
  });

  it('D-50: 2xx без формы { data: [{ id }] } — network', async () => {
    const bodies = [{ models: [] }, { data: [{ name: 'x' }] }];

    for (const body of bodies) {
      const result = await upstreamFor(STUB_URL, {
        fetch: stubFetch(Response.json(body)),
      }).listModels(signal());

      expect(result).toEqual({ ok: false, failure: { kind: 'network' } });
    }
  });
});
