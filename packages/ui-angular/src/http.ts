import type { AuthSessionKeeper } from '@swag/ui-core';

// Спека 014, 4.7: ошибка ответа; code — из тела `{ error: { code } }`, без кода — 'unknown'.
export class HttpError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

// Спека 012, 024: тело ошибки — `{ error: { code, message } }`; тело не JSON — только статус.
export async function httpError(response: Response): Promise<HttpError> {
  const payload = (await response.json().catch(() => undefined)) as
    { error?: { code?: unknown; message?: unknown } } | undefined;
  const code = payload?.error?.code;
  const message = payload?.error?.message;
  return new HttpError(
    response.status,
    typeof code === 'string' ? code : 'unknown',
    typeof message === 'string' ? message : `HTTP ${response.status}`,
  );
}

export type RequestSession = Pick<AuthSessionKeeper, 'accessToken' | 'renew'>;

// Спека 024, 4.15 и 014, 4.7: Bearer-токен сессии; на 401 — один renew и повтор. Одновременные 401 делят один renew.
// Неудача renew — keeper сам выводит пользователя (onSignedOut), здесь ошибка 401 уходит вызывающему.
export function createRequest(session: RequestSession, basePath: string) {
  let renewing: Promise<boolean> | null = null;
  const renewOnce = (): Promise<boolean> => {
    renewing ??= session.renew().finally(() => {
      renewing = null;
    });
    return renewing;
  };

  const send = (method: string, path: string, body?: unknown): Promise<Response> => {
    const token = session.accessToken();
    return fetch(`${basePath}${path}`, {
      method,
      headers: {
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(token === null ? {} : { authorization: `Bearer ${token}` }),
      },
      body: body === undefined ? null : JSON.stringify(body),
    });
  };

  return async <T>(method: string, path: string, body?: unknown): Promise<T> => {
    let response = await send(method, path, body);
    if (response.status === 401 && (await renewOnce())) {
      response = await send(method, path, body);
    }
    if (!response.ok) throw await httpError(response);
    const payload =
      response.status === 202 || response.status === 204 ? undefined : await response.json();
    return payload as T;
  };
}
