import type { Location } from '@angular/common';
import type { ActivatedRoute } from '@angular/router';

// Спека 014, REQ-014-9: токен из query читается один раз и сразу убирается из адреса; в лог не попадает.
export function takeToken(
  route: ActivatedRoute,
  location: Location,
  pagePath: string,
): string | null {
  const token = route.snapshot.queryParamMap.get('token');
  location.replaceState(pagePath);
  return token;
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
