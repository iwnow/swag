import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import {
  AlertComponent,
  ButtonDirective,
  connectStore,
  FieldComponent,
  PageComponent,
  SESSION_USER,
  SHELL_STORE,
} from '@swag/ui-angular';
import { REGISTRATION_SENT_TEXT } from '@swag/ui-core';
import { inputValue, issueText } from './auth-page.ts';

// Спека 014, 4.11 и REQ-014-6: /signup — email; сообщение 4.6 одно и на известный, и на неизвестный адрес.
@Component({
  selector: 'app-signup-page',
  imports: [RouterLink, AlertComponent, ButtonDirective, FieldComponent, PageComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <swag-page title="Регистрация">
      @if (shell.form().sent) {
        <swag-alert kind="info">{{ sentText }}</swag-alert>
      } @else {
        <form (submit)="$event.preventDefault(); submit()">
          <swag-field label="Email" [error]="issue('email')">
            <input
              type="email"
              autocomplete="username"
              required
              [value]="email()"
              (input)="email.set(inputValue($event))"
            />
          </swag-field>
          @if (shell.form().error; as message) {
            <swag-alert kind="error">{{ message }}</swag-alert>
          }
          <button swag-button type="submit" [busy]="shell.form().busy">Зарегистрироваться</button>
        </form>
      }
      <p><a routerLink="/login">Уже есть аккаунт</a></p>
    </swag-page>
  `,
})
export class SignupPageComponent {
  protected readonly shell = inject(SHELL_STORE);
  private readonly session = connectStore(inject(SESSION_USER));
  private readonly router = inject(Router);
  protected readonly sentText = REGISTRATION_SENT_TEXT;
  protected readonly inputValue = inputValue;
  readonly email = signal('');

  constructor() {
    this.shell.resetForm();
    // Сессия уже открыта — регистрация не нужна.
    void this.session.restore().then(() => {
      if (this.session.accessToken() !== null) void this.router.navigateByUrl('/');
    });
  }

  protected issue(path: string): string | null {
    return issueText(this.shell.form().issues, path);
  }

  protected async submit(): Promise<void> {
    await this.shell.register(this.email());
  }
}
