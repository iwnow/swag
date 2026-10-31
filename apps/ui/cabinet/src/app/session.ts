import { InjectionToken } from '@angular/core';
import { createAuthSessionKeeper, type AuthSessionKeeper } from '@swag/ui-core';
import { authApi } from './auth-api.ts';

// Спека 024, 4.15: один AuthSessionKeeper на приложение.
export const SESSION = new InjectionToken<AuthSessionKeeper>('auth-session', {
  factory: () => createAuthSessionKeeper(authApi),
});
