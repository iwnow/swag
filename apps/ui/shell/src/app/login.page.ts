import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import {
  AlertComponent,
  ButtonDirective,
  ensureRestored,
  FieldComponent,
  PageComponent,
  SESSION,
} from '@swag/ui-angular';
import { authErrorText, safeReturnTo } from '@swag/ui-core';

// Спека 014, 4.11: /login?returnTo= — при открытой сессии сразу на safeReturnTo(returnTo).
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
        @if (error(); as message) {
          <swag-alert kind="error">{{ message }}</swag-alert>
        }
        <button swag-button type="submit" [busy]="busy()">Войти</button>
      </form>
      <p><a routerLink="/signup">Зарегистрировать компанию</a></p>
    </swag-page>
  `,
})
export class LoginPageComponent {
  private readonly session = inject(SESSION);
  private readonly router = inject(Router);
  private readonly returnTo = safeReturnTo(
    inject(ActivatedRoute).snapshot.queryParamMap.get('returnTo'),
  );
  readonly email = signal('');
  readonly password = signal('');
  readonly error = signal<string | null>(null);
  readonly busy = signal(false);

  constructor() {
    void ensureRestored().then(() => {
      if (this.session.accessToken() !== null) void this.router.navigateByUrl(this.returnTo);
    });
  }

  protected inputValue(event: Event): string {
    return (event.target as HTMLInputElement).value;
  }

  protected async submit(): Promise<void> {
    this.busy.set(true);
    this.error.set(null);
    const result = await this.session.login(this.email(), this.password());
    this.busy.set(false);
    if (result.ok) {
      await this.router.navigateByUrl(this.returnTo);
      return;
    }
    this.password.set('');
    this.error.set(authErrorText(result.code));
  }
}
