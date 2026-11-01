import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRequest, HttpError } from '../src/http.ts';

const json = (status: number, body?: unknown): Response =>
  new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

// renew отвечает не сразу: одновременные запросы успевают получить 401 до его окончания.
function makeSession() {
  let token: string | null = 'old';
  const renew = vi.fn(
    () =>
      new Promise<boolean>((resolve) => {
        setTimeout(() => {
          token = 'new';
          resolve(true);
        }, 5);
      }),
  );
  const onSignedOut = vi.fn(() => () => undefined);
  const session = { accessToken: () => token, renew, onSignedOut };
  return { session, renew, onSignedOut };
}

const authorization = (init: RequestInit | undefined): string | undefined =>
  (init?.headers as Record<string, string> | undefined)?.authorization;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('createRequest', () => {
  it('AC-014-19: 403 — reject HttpError с кодом, без renew и onSignedOut', async () => {
    const { session, renew, onSignedOut } = makeSession();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json(403, { error: { code: 'forbidden', message: 'нет' } })),
    );

    const error = await createRequest(session, '/auth')('GET', '/users').catch((e: unknown) => e);

    expect(error).toBeInstanceOf(HttpError);
    expect(error).toMatchObject({ status: 403, code: 'forbidden' });
    expect(renew).not.toHaveBeenCalled();
    expect(onSignedOut).not.toHaveBeenCalled();
  });

  it('AC-014-19: 401, затем 200 — один renew и один повтор с новым токеном', async () => {
    const { session, renew } = makeSession();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json(401, { error: { code: 'unauthorized' } }))
      .mockResolvedValueOnce(json(200, { ok: true }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await createRequest(session, '/api')<{ ok: boolean }>('GET', '/swarms');

    expect(result).toEqual({ ok: true });
    expect(renew).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(authorization(fetchMock.mock.calls[0]?.[1])).toBe('Bearer old');
    expect(authorization(fetchMock.mock.calls[1]?.[1])).toBe('Bearer new');
  });

  it('AC-014-19: два одновременных 401 — renew вызван один раз', async () => {
    const { session, renew } = makeSession();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init?: RequestInit) =>
        authorization(init) === 'Bearer old'
          ? json(401, { error: { code: 'unauthorized' } })
          : json(200, { ok: true }),
      ),
    );

    const request = createRequest(session, '/api');
    const results = await Promise.all([request('GET', '/a'), request('GET', '/b')]);

    expect(results).toEqual([{ ok: true }, { ok: true }]);
    expect(renew).toHaveBeenCalledTimes(1);
  });

  it('AC-014-19: 401, renew → false — reject HttpError 401 без повтора', async () => {
    const { session, renew } = makeSession();
    renew.mockResolvedValueOnce(false);
    const fetchMock = vi.fn(async () => json(401, { error: { code: 'unauthorized' } }));
    vi.stubGlobal('fetch', fetchMock);

    const error = await createRequest(session, '/api')('GET', '/swarms').catch((e: unknown) => e);

    expect(error).toBeInstanceOf(HttpError);
    expect(error).toMatchObject({ status: 401 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(renew).toHaveBeenCalledTimes(1);
  });

  it('AC-014-19: 500 без тела — HttpError { status: 500, code: unknown }', async () => {
    const { session } = makeSession();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(null, { status: 500 })),
    );

    const error = await createRequest(session, '/api')('GET', '/swarms').catch((e: unknown) => e);

    expect(error).toBeInstanceOf(HttpError);
    expect(error).toMatchObject({ status: 500, code: 'unknown' });
  });

  it('AC-014-19: 500 с телом не JSON — HttpError { status: 500, code: unknown }', async () => {
    const { session } = makeSession();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('oops', { status: 500 })),
    );

    const error = await createRequest(session, '/api')('GET', '/swarms').catch((e: unknown) => e);

    expect(error).toBeInstanceOf(HttpError);
    expect(error).toMatchObject({ status: 500, code: 'unknown' });
  });

  it('AC-014-19: basePath /auth и путь /me — fetch на /auth/me', async () => {
    const { session } = makeSession();
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => json(200, { ok: true }));
    vi.stubGlobal('fetch', fetchMock);

    await createRequest(session, '/auth')<{ ok: boolean }>('GET', '/me');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/auth/me');
  });
});
