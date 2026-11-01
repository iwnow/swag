import { inject } from '@angular/core';
import { type CanMatchFn, Router } from '@angular/router';
import type { UiArea } from '@swag/ui-core';
import { SESSION_USER } from './stores.ts';

// Спека 014, 4.4 и 4.12: восстановление сессии, нет токена — /login с returnTo.
export const sessionGuard: CanMatchFn = async () => {
  const session = inject(SESSION_USER);
  const router = inject(Router);
  await session.restore();
  if (session.accessToken() === null) {
    return router.createUrlTree(['/login'], {
      queryParams: { returnTo: router.serializeUrl(router.currentNavigation()!.extractedUrl) },
    });
  }
  return true;
};

// Спека 014, 4.7 и 4.12: доступ к разделу по таблице 4.2 (`canOpen`); нет доступа — `/`.
export const areaGuard =
  (area: UiArea): CanMatchFn =>
  async () => {
    const session = inject(SESSION_USER);
    const router = inject(Router);
    await session.ensureMe();
    return session.canOpen(area) ? true : router.createUrlTree(['/']);
  };
