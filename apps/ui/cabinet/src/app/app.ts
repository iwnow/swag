import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { takeUntilDestroyed, toSignal } from '@angular/core/rxjs-interop';
import { NavigationEnd, Router, RouterLink, RouterOutlet } from '@angular/router';
import { filter, map } from 'rxjs';
import { CurrentUser, SESSION } from './session.ts';

@Component({
  selector: 'app-root',
  imports: [RouterOutlet, RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <header>
      <a routerLink="/" class="brand">Swag · Личный кабинет</a>
      <nav>
        @if (hasOrganization()) {
          <a routerLink="/balance" class="nav-link">Баланс</a>
        }
        @if (!onLoginPage()) {
          <button type="button" class="secondary" (click)="logout()">Выйти</button>
        }
      </nav>
    </header>
    <main>
      <router-outlet />
    </main>
  `,
  styles: `
    header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 12px 24px;
      background: #111827;
    }
    .brand {
      color: #f9fafb;
      font:
        600 16px system-ui,
        sans-serif;
      text-decoration: none;
    }
    nav {
      display: flex;
      align-items: center;
      gap: 16px;
    }
    .nav-link {
      color: #f9fafb;
    }
  `,
})
export class App {
  private readonly session = inject(SESSION);
  private readonly current = inject(CurrentUser);
  private readonly router = inject(Router);
  // Спека 013, 4.11: пункт «Баланс» — только у пользователя с организацией из /auth/me (у супервизора её нет).
  readonly hasOrganization = computed(() => this.current.orgId() !== null);
  readonly onLoginPage = toSignal(
    this.router.events.pipe(
      filter((event): event is NavigationEnd => event instanceof NavigationEnd),
      map((event) => event.urlAfterRedirects.startsWith('/login')),
    ),
    { initialValue: this.router.url.startsWith('/login') },
  );

  constructor() {
    this.session.onSignedOut(() => {
      this.current.clear();
      void this.router.navigateByUrl('/login');
    });
    // Смена токена (renew) заметна на следующей навигации: ensure перечитает /auth/me, если токен новый.
    this.router.events
      .pipe(
        filter((event): event is NavigationEnd => event instanceof NavigationEnd),
        takeUntilDestroyed(),
      )
      .subscribe(() => void this.current.ensure());
  }

  // Трактовка: ошибка api.logout не показывается — токен на клиенте уже стёрт.
  async logout(): Promise<void> {
    await this.session.logout().catch(() => undefined);
    this.current.clear();
    await this.router.navigateByUrl('/login');
  }
}
