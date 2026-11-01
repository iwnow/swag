import { ChangeDetectionStrategy, Component, effect, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { NavigationEnd, NavigationError, Router, RouterOutlet } from '@angular/router';
import { filter } from 'rxjs';
import { AlertComponent, connectStore, SESSION_USER, SHELL_STORE } from '@swag/ui-angular';
import type { ThemeMode } from '@swag/ui-core';

// Спека 014, 4.12: тема на <html> — работа с DOM; «system» — атрибута нет, тему выбирает prefers-color-scheme.
function applyTheme(mode: ThemeMode): void {
  const root = document.documentElement;
  if (mode === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', mode);
}

// Спека 014, REQ-014-4 и REQ-014-14: смена токена перечитывает AuthMe на следующей навигации; выход — на /login.
// Спека 014, 4.6: alert «Раздел недоступен» — здесь, вне Layout: при первой навигации на `/` Layout не создаётся.
@Component({
  selector: 'app-root',
  imports: [RouterOutlet, AlertComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (unavailable()) {
      <swag-alert kind="error">Раздел недоступен</swag-alert>
    }
    <router-outlet />
  `,
})
export class App {
  protected readonly unavailable = signal(false);
  private readonly shell = inject(SHELL_STORE);
  private readonly session = connectStore(inject(SESSION_USER));

  constructor() {
    const router = inject(Router);

    // Применяет data-theme при создании корня — и на /login до входа.
    effect(() => applyTheme(this.shell.theme()));

    // Выход — переход с «вошёл» на «вышел». Первичное «вышел» (нет сессии при загрузке) уводит guard'ом, не сюда.
    let wasSignedIn = false;
    effect(() => {
      const status = this.session.status();
      if (status === 'signed-in') wasSignedIn = true;
      if (status === 'signed-out' && wasSignedIn) {
        wasSignedIn = false;
        void router.navigateByUrl('/login');
      }
    });

    router.events
      .pipe(
        filter((event) => event instanceof NavigationEnd || event instanceof NavigationError),
        takeUntilDestroyed(),
      )
      .subscribe((event) => {
        if (event instanceof NavigationError) {
          this.unavailable.set(true);
          return;
        }
        this.unavailable.set(false);
        void this.session.ensureMe();
      });
  }
}
