import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import { SESSION } from '@swag/ui-angular';

// Спека 024, 4.2: тексты по коду ошибки входа; неизвестный код — общий текст.
const LOGIN_ERRORS: Record<string, string> = {
  invalid_credentials: 'Неверный email или пароль.',
  user_blocked: 'Пользователь заблокирован. Обратитесь к администратору организации.',
  validation_error: 'Проверьте email и пароль.',
  rate_limited: 'Слишком много попыток. Попробуйте позже.',
};
const FALLBACK_ERROR = 'Не удалось войти. Попробуйте ещё раз.';

@Component({
  selector: 'app-login-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <h1>Вход</h1>
    <form (submit)="$event.preventDefault(); submit()">
      <label>
        Email
        <input
          type="email"
          autocomplete="username"
          required
          [value]="email()"
          (input)="setEmail($event)"
        />
      </label>
      <label>
        Пароль
        <input
          type="password"
          autocomplete="current-password"
          required
          [value]="password()"
          (input)="setPassword($event)"
        />
      </label>
      @if (error(); as message) {
        <p class="error" role="alert">{{ message }}</p>
      }
      <button type="submit" [disabled]="busy()">Войти</button>
    </form>
  `,
})
export class LoginPageComponent {
  private readonly session = inject(SESSION);
  private readonly router = inject(Router);
  readonly email = signal('');
  readonly password = signal('');
  readonly error = signal<string | null>(null);
  readonly busy = signal(false);

  setEmail(event: Event): void {
    this.email.set((event.target as HTMLInputElement).value);
  }

  setPassword(event: Event): void {
    this.password.set((event.target as HTMLInputElement).value);
  }

  async submit(): Promise<void> {
    this.busy.set(true);
    this.error.set(null);
    const result = await this.session.login(this.email(), this.password());
    this.busy.set(false);
    if (result.ok) {
      await this.router.navigateByUrl('/');
      return;
    }
    this.password.set('');
    this.error.set(LOGIN_ERRORS[result.code] ?? FALLBACK_ERROR);
  }
}
