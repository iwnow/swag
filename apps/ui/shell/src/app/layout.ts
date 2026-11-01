import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { Router, RouterLink, RouterOutlet } from '@angular/router';
import {
  ButtonDirective,
  CurrentUser,
  SESSION,
  ThemeService,
  type ThemeMode,
} from '@swag/ui-angular';
import { navigationFor } from '@swag/ui-core';

const THEME_MODES: readonly ThemeMode[] = ['system', 'light', 'dark'];
const THEME_LABEL: Record<ThemeMode, string> = {
  system: 'Как в системе',
  light: 'Светлая',
  dark: 'Тёмная',
};

// Спека 014, REQ-014-10: шапка каркаса — пункты по navigationFor, пользователь, тема, выход.
@Component({
  selector: 'app-layout',
  imports: [RouterLink, RouterOutlet, ButtonDirective],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <header class="shell-header">
      <a routerLink="/" class="brand">Swag</a>
      <nav aria-label="Разделы">
        @for (item of navigation(); track item.path) {
          <a [routerLink]="item.path">{{ item.label }}</a>
        }
      </nav>
      <div class="account">
        @if (who(); as text) {
          <span class="who">{{ text }}</span>
        }
        <label>
          Тема
          <select (change)="setTheme($event)">
            @for (mode of modes; track mode) {
              <option [value]="mode" [selected]="mode === theme.mode()">{{ labels[mode] }}</option>
            }
          </select>
        </label>
        <button swag-button variant="secondary" type="button" (click)="logout()">Выйти</button>
      </div>
    </header>
    <main>
      <router-outlet />
    </main>
  `,
  styles: `
    .shell-header {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      justify-content: space-between;
      gap: var(--swag-space-3);
      padding: var(--swag-space-3) var(--swag-space-4);
      background: var(--swag-color-surface);
      border-bottom: 1px solid var(--swag-color-border);
    }
    .brand {
      font-weight: 600;
      color: var(--swag-color-text);
      text-decoration: none;
    }
    nav,
    .account {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: var(--swag-space-3);
    }
    .who {
      color: var(--swag-color-text-muted);
      font-size: var(--swag-text-sm);
    }
    label {
      font-size: var(--swag-text-sm);
    }
  `,
})
export class LayoutComponent {
  private readonly session = inject(SESSION);
  private readonly current = inject(CurrentUser);
  private readonly router = inject(Router);
  protected readonly theme = inject(ThemeService);
  protected readonly modes = THEME_MODES;
  protected readonly labels = THEME_LABEL;
  protected readonly navigation = computed(() => navigationFor(this.current.me()));
  protected readonly who = computed(() => {
    const me = this.current.me();
    if (me === null) return null;
    return me.organization === null ? me.user.email : `${me.user.email} · ${me.organization.name}`;
  });
  protected setTheme(event: Event): void {
    const value = (event.target as HTMLSelectElement).value;
    const mode = THEME_MODES.find((candidate) => candidate === value);
    if (mode !== undefined) this.theme.setMode(mode);
  }

  // Трактовка: ошибка logout не показывается — токен на клиенте уже стёрт (как в кабинете).
  protected async logout(): Promise<void> {
    await this.session.logout().catch(() => undefined);
    this.current.clear();
    await this.router.navigateByUrl('/login');
  }
}
