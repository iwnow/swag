import { Location } from '@angular/common';
import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import {
  AlertComponent,
  ButtonDirective,
  connectStore,
  FieldComponent,
  PageComponent,
  SESSION_USER,
  SHELL_STORE,
} from '@swag/ui-angular';
import { authErrorText } from '@swag/ui-core';
import { inputValue, issueText, restoreSession, takeToken } from './auth-page.ts';
import { SignedInNoticeComponent } from './signed-in-notice.ts';

// Спека 014, 4.11, REQ-014-7 и REQ-014-9: /signup/confirm?token= — пароль, повтор и название организации.
@Component({
  selector: 'app-signup-confirm-page',
  imports: [
    RouterLink,
    AlertComponent,
    ButtonDirective,
    FieldComponent,
    PageComponent,
    SignedInNoticeComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <swag-page title="Регистрация компании">
      @if (ready()) {
        @if (!hasToken) {
          <swag-alert kind="error">{{ invalidTokenText }}</swag-alert>
          <p><a routerLink="/signup">Зарегистрироваться заново</a></p>
        } @else if (session.status() === 'signed-in') {
          <app-signed-in-notice [email]="session.me()?.user.email" />
        } @else {
          <form (submit)="$event.preventDefault(); submit()">
            <swag-field label="Пароль" [error]="issue('password')">
              <input
                type="password"
                autocomplete="new-password"
                required
                [value]="password()"
                (input)="password.set(inputValue($event))"
              />
            </swag-field>
            <swag-field label="Повторите пароль" [error]="issue('repeat')">
              <input
                type="password"
                autocomplete="new-password"
                required
                [value]="repeat()"
                (input)="repeat.set(inputValue($event))"
              />
            </swag-field>
            <swag-field label="Название организации" [error]="issue('organizationName')">
              <input
                type="text"
                required
                [value]="organizationName()"
                (input)="organizationName.set(inputValue($event))"
              />
            </swag-field>
            @if (shell.form().error; as message) {
              <swag-alert kind="error">{{ message }}</swag-alert>
              @if (shell.form().invalidToken) {
                <p><a routerLink="/signup">Зарегистрироваться заново</a></p>
              }
            }
            <button swag-button type="submit" [busy]="shell.form().busy">Создать компанию</button>
          </form>
        }
      }
    </swag-page>
  `,
})
export class SignupConfirmPageComponent {
  protected readonly shell = inject(SHELL_STORE);
  protected readonly session = connectStore(inject(SESSION_USER));
  private readonly router = inject(Router);
  private readonly token = takeToken(inject(ActivatedRoute), inject(Location), '/signup/confirm');
  protected readonly hasToken = this.token !== null;
  protected readonly invalidTokenText = authErrorText('invalid_token');
  protected readonly inputValue = inputValue;
  readonly ready = signal(false);
  readonly password = signal('');
  readonly repeat = signal('');
  readonly organizationName = signal('');

  constructor() {
    this.shell.resetForm();
    restoreSession(this.session, () => this.ready.set(true));
  }

  protected issue(path: string): string | null {
    return issueText(this.shell.form().issues, path);
  }

  protected async submit(): Promise<void> {
    const next = await this.shell.confirmRegistration({
      token: this.token ?? '',
      password: this.password(),
      repeat: this.repeat(),
      organizationName: this.organizationName(),
    });
    if (next !== null) {
      await this.router.navigateByUrl(next);
      return;
    }
    this.password.set('');
    this.repeat.set('');
  }
}
