import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { NavigationEnd, NavigationError, Router, RouterOutlet } from '@angular/router';
import { filter } from 'rxjs';
import { AlertComponent, CurrentUser, SESSION, ThemeService } from '@swag/ui-angular';

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
  // Применяет data-theme при создании корня — и на /login до входа.
  protected readonly theme = inject(ThemeService);
  protected readonly unavailable = signal(false);

  constructor() {
    const session = inject(SESSION);
    const current = inject(CurrentUser);
    const router = inject(Router);
    session.onSignedOut(() => {
      current.clear();
      void router.navigateByUrl('/login');
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
        void current.ensure();
      });
  }
}
