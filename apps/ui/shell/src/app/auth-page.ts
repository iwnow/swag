import type { Location } from '@angular/common';
import { DestroyRef, inject } from '@angular/core';
import type { ActivatedRoute } from '@angular/router';

// Спека 014, REQ-014-9: токен из query читается один раз и сразу убирается из адреса; в лог не попадает.
// Пустой token — как отсутствующий.
export function takeToken(
  route: ActivatedRoute,
  location: Location,
  pagePath: string,
): string | null {
  const token = route.snapshot.queryParamMap.get('token') || null;
  location.replaceState(pagePath);
  return token;
}

// Восстановление сессии на странице каркаса (конструктор страницы): `done` вызывается после `restore`,
// в том числе при его отказе, и только пока страница не уничтожена — иначе переход уведёт чужой экран.
export function restoreSession(session: { restore(): Promise<unknown> }, done: () => void): void {
  let alive = true;
  inject(DestroyRef).onDestroy(() => (alive = false));
  void session
    .restore()
    .catch(() => undefined)
    .finally(() => {
      if (alive) done();
    });
}

// Текст ошибки поля из `ShellForm.issues` (пути — имена полей из `auth-forms.ts`).
export function issueText(
  issues: readonly { path: string; message: string }[],
  path: string,
): string | null {
  return issues.find((issue) => issue.path === path)?.message ?? null;
}

export function inputValue(event: Event): string {
  return (event.target as HTMLInputElement).value;
}
