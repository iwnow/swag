import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRequest, HttpError, type RequestSession } from '../src/http.ts';

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
  const session: RequestSession = { accessToken: () => token, renew, onSignedOut };
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
});
