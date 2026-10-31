import { InjectionToken } from '@angular/core';
import { AccessTokenClaims, type Role } from '@swag/contracts';
import { createAuthSessionKeeper, type AuthSessionKeeper } from '@swag/ui-core';
import { authApi } from './auth-api.ts';

// Спека 024, 4.15: один AuthSessionKeeper на приложение.
export const SESSION = new InjectionToken<AuthSessionKeeper>('auth-session', {
  factory: () => createAuthSessionKeeper(authApi),
});

// Спека 013, 4.11: роль и организация текущего пользователя. Keeper хранит только токен доступа,
// поэтому claims читаются из него (`sub`, `org`, `role` — те же поля, что в `AuthSession.user`).
// Только для показа пунктов и форм: права проверяет API.
export function currentUser(
  session: AuthSessionKeeper,
): { role: Role; orgId: string | null } | null {
  const token = session.accessToken();
  const payload = token?.split('.')[1];
  if (payload === undefined) return null;
  let json: unknown;
  try {
    json = JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/')));
  } catch {
    return null;
  }
  const claims = AccessTokenClaims.safeParse(json);
  return claims.success ? { role: claims.data.role, orgId: claims.data.org } : null;
}
