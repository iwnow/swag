import { effect, inject } from '@angular/core';
import { type CanMatchFn, Router } from '@angular/router';
import type { UiArea } from '@swag/ui-core';
import { connectStore, SESSION_USER } from './stores.ts';

// Открытые страницы каркаса (спека 014, T-14): без сессии доступны, выход на них не уводит на `/login`.
const OPEN_PATHS = ['/login', '/signup', '/signup/confirm', '/invite'];

// Спека 014, REQ-014-14, REQ-014-9 и 4.12: выход — переход на `/login` при любом переходе статуса в `signed-out`,
// кроме открытых страниц `OPEN_PATHS` (сравнение по пути, без query), и только после первой навигации роутера:
// до неё `sessionGuard` сам строит `returnTo`. Вызывается в injection context (конструктор корня приложения).
export function redirectOnSignOut(): void {
  const session = connectStore(inject(SESSION_USER));
  const router = inject(Router);
  effect(() => {
    if (session.status() !== 'signed-out') return;
    if (!router.navigated || OPEN_PATHS.includes(router.url.replace(/[?#].*/, ''))) return;
    void router.navigateByUrl('/login');
  });
}

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
