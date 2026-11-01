import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { NavigationEnd, Router, RouterOutlet } from '@angular/router';
import { filter } from 'rxjs';
import { CurrentUser, SESSION } from '@swag/ui-angular';

// Спека 014, REQ-014-4 и REQ-014-14: смена токена перечитывает AuthMe на следующей навигации; выход — на /login.
@Component({
  selector: 'app-root',
  imports: [RouterOutlet],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<router-outlet />`,
})
export class App {
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
        filter((event): event is NavigationEnd => event instanceof NavigationEnd),
        takeUntilDestroyed(),
      )
      .subscribe(() => void current.ensure());
  }
}
