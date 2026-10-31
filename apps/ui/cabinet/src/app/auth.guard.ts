import { inject } from '@angular/core';
import { type CanActivateFn, Router } from '@angular/router';
import { SESSION } from './session.ts';

// Спека 024, REQ-024-13: маршруты роёв — только после входа. Нет токена — restore() по cookie, неудача — /login.
export const authGuard: CanActivateFn = async () => {
  const session = inject(SESSION);
  const router = inject(Router);
  if (session.accessToken() !== null || (await session.restore())) return true;
  return router.createUrlTree(['/login']);
};
