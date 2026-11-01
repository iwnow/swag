import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import {
  AlertComponent,
  ButtonDirective,
  FieldComponent,
  PageComponent,
  SESSION_USER,
  SHELL_STORE,
} from '@swag/ui-angular';
import { safeReturnTo } from '@swag/ui-core';

// Спека 014, 4.11 и 4.12: /login?returnTo= — вход через ShellStore; при открытой сессии сразу на returnTo.
@Component({
  selector: 'app-login-page',
  imports: [RouterLink, AlertComponent, ButtonDirective, FieldComponent, PageComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <swag-page title="Вход">
      <form (submit)="$event.preventDefault(); submit()">
        <swag-field label="Email">
          <input
            type="email"
            autocomplete="username"
            required
            [value]="email()"
            (input)="email.set(inputValue($event))"
          />
        </swag-field>
        <swag-field label="Пароль">
          <input
            type="password"
            autocomplete="current-password"
            required
            [value]="password()"
            (input)="password.set(inputValue($event))"
          />
        </swag-field>
        @if (shell.form().error; as message) {
          <swag-alert kind="error">{{ message }}</swag-alert>
        }
        <button swag-button type="submit" [busy]="shell.form().busy">Войти</button>
      </form>
      <p><a routerLink="/signup">Зарегистрировать компанию</a></p>
    </swag-page>
  `,
})
export class LoginPageComponent {
  protected readonly shell = inject(SHELL_STORE);
  private readonly session = inject(SESSION_USER);
  private readonly router = inject(Router);
  private readonly returnTo = safeReturnTo(
    inject(ActivatedRoute).snapshot.queryParamMap.get('returnTo'),
  );
  readonly email = signal('');
  readonly password = signal('');

  constructor() {
    // Форма ShellStore общая для страниц каркаса — чужие ошибка и busy не должны попасть на вход.
    this.shell.resetForm();
    // Сессия уже открыта (например, после обновления страницы) — сразу на returnTo.
    void this.session.restore().then(() => {
      if (this.session.accessToken() !== null) void this.router.navigateByUrl(this.returnTo);
    });
  }

  protected inputValue(event: Event): string {
    return (event.target as HTMLInputElement).value;
  }

  protected async submit(): Promise<void> {
    const next = await this.shell.login(this.email(), this.password(), this.returnTo);
    if (next !== null) {
      await this.router.navigateByUrl(next);
      return;
    }
    this.password.set('');
  }
}
