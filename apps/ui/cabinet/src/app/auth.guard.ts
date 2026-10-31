import { inject } from '@angular/core';
import { type CanActivateFn, Router } from '@angular/router';
import { CurrentUser, SESSION } from './session.ts';

// Спека 024, REQ-024-13: маршруты роёв — только после входа. Нет токена — restore() по cookie, неудача — /login.
// Спека 013, 4.11 (D-130): после входа или восстановления роль и организация перечитываются из /auth/me до показа страницы.
export const authGuard: CanActivateFn = async () => {
  const session = inject(SESSION);
  const current = inject(CurrentUser);
  const router = inject(Router);
  if (session.accessToken() === null && !(await session.restore())) {
    return router.createUrlTree(['/login']);
  }
  await current.ensure();
  return true;
};
