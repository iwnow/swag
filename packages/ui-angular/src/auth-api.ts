import {
  AuthMe,
  type AuthRefreshed,
  type AuthSession,
  type InvitationAcceptRequest,
  type RegistrationConfirmRequest,
} from '@swag/contracts';
import type { AuthApi, MeApi } from '@swag/ui-core';
import { httpError } from './http.ts';

// Спека 024, 4.15: адаптер AuthApi на fetch. Идёт через прокси `/auth` → identity; cookie swag_refresh — same-origin.

async function post(path: string, body?: unknown): Promise<Response> {
  return fetch(`/auth${path}`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? null : JSON.stringify(body),
  });
}

async function signIn(
  path: string,
  body: { email: string; password: string } | RegistrationConfirmRequest | InvitationAcceptRequest,
): Promise<AuthSession> {
  const response = await post(path, body);
  if (!response.ok) throw await httpError(response);
  return (await response.json()) as AuthSession;
}

// Спека 013, 4.11 (D-130): GET /auth/me с токеном доступа; ответ разбирает meApi по схеме AuthMe.
export function getMe(token: string): Promise<Response> {
  return fetch('/auth/me', {
    credentials: 'same-origin',
    headers: { authorization: `Bearer ${token}` },
  });
}

// Спека 014, 4.12: MeApi поверх getMe. 401 — null; прочая ошибка и неразобранный ответ — исключение (ensureMe сбрасывает кэш, D-147).
export const meApi: MeApi = {
  async me(token) {
    const response = await getMe(token);
    if (response.status === 401) return null;
    if (!response.ok) throw await httpError(response);
    return AuthMe.parse(await response.json());
  },
};

export const authApi: AuthApi = {
  login: (email, password) => signIn('/login', { email, password }),
  async refresh() {
    const response = await post('/refresh');
    if (response.status === 401) return null;
    if (!response.ok) throw await httpError(response);
    return (await response.json()) as AuthRefreshed;
  },
  async logout() {
    const response = await post('/logout');
    if (!response.ok) throw await httpError(response);
  },
  async register(email) {
    const response = await post('/registrations', { email });
    if (!response.ok) throw await httpError(response);
  },
  confirmRegistration: (body) => signIn('/registrations/confirm', body),
  acceptInvitation: (body) => signIn('/invitations/accept', body),
};
