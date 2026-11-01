import { inject } from '@angular/core';
import { type CanMatchFn, Router } from '@angular/router';
import { canOpen, type UiArea } from '@swag/ui-core';
import { CurrentUser, SESSION } from './session.ts';

// Спека 014, 4.7: один restore() на загрузку страницы. Промис кэшируется в модульной переменной;
// повторные вызовы получают тот же промис. Есть токен — restore не нужен. Вызывать в injection context.
let restoring: Promise<boolean> | null = null;

export function ensureRestored(): Promise<boolean> {
  const session = inject(SESSION);
  if (session.accessToken() !== null) return Promise.resolve(true);
  restoring ??= session.restore();
  return restoring;
}

// Спека 014, 4.4 и 4.7: восстановление сессии, затем роль и организация. Нет токена — /login с returnTo.
export const sessionGuard: CanMatchFn = async () => {
  const session = inject(SESSION);
  const current = inject(CurrentUser);
  const router = inject(Router);
  await ensureRestored();
  if (session.accessToken() === null) {
    return router.createUrlTree(['/login'], {
      queryParams: { returnTo: router.serializeUrl(router.currentNavigation()!.extractedUrl) },
    });
  }
  await current.ensure();
  return true;
};

// Спека 014, 4.7: доступ к разделу по таблице 4.2 (`canOpen`); нет доступа — `/`.
export const areaGuard =
  (area: UiArea): CanMatchFn =>
  async () => {
    const current = inject(CurrentUser);
    const router = inject(Router);
    await current.ensure();
    return canOpen(area, current.me()) ? true : router.createUrlTree(['/']);
  };
