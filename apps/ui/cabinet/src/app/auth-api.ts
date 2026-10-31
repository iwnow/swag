import type { AuthRefreshed, AuthSession } from '@swag/contracts';
import type { AuthApi } from '@swag/ui-core';

// Спека 024, 4.15: адаптер AuthApi на fetch. Идёт через прокси `/auth` → identity; cookie swag_refresh — same-origin.

class AuthRequestError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

async function post(path: string, body?: unknown): Promise<Response> {
  return fetch(`/auth${path}`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function failure(response: Response): Promise<AuthRequestError> {
  const payload = (await response.json().catch(() => undefined)) as
    { error?: { code?: unknown } } | undefined;
  const code = payload?.error?.code;
  return new AuthRequestError(typeof code === 'string' ? code : 'unknown');
}

export const authApi: AuthApi = {
  async login(email, password) {
    const response = await post('/login', { email, password });
    if (!response.ok) throw await failure(response);
    return (await response.json()) as AuthSession;
  },
  async refresh() {
    const response = await post('/refresh');
    if (response.status === 401) return null;
    if (!response.ok) throw await failure(response);
    return (await response.json()) as AuthRefreshed;
  },
  async logout() {
    const response = await post('/logout');
    if (!response.ok) throw await failure(response);
  },
};
