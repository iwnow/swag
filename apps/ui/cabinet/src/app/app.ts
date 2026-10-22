import { ChangeDetectionStrategy, Component } from '@angular/core';
import { RouterLink, RouterOutlet } from '@angular/router';

@Component({
  selector: 'app-root',
  imports: [RouterOutlet, RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <header>
      <a routerLink="/" class="brand">Swag · Личный кабинет</a>
    </header>
    <main>
      <router-outlet />
    </main>
  `,
  styles: `
    header {
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
  `,
})
export class App {}
