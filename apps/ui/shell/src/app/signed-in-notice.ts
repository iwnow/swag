import { ChangeDetectionStrategy, Component, inject, input } from '@angular/core';
import { ButtonDirective, SHELL_STORE } from '@swag/ui-angular';

// Спека 014, 4.11, REQ-014-9: открытая страница при открытой сессии — «Вы вошли как …» и выход, после которого форма.
@Component({
  selector: 'app-signed-in-notice',
  imports: [ButtonDirective],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <p>Вы вошли как {{ email() }}</p>
    <button swag-button type="button" [busy]="shell.form().busy" (click)="leave()">
      Выйти и продолжить
    </button>
  `,
})
export class SignedInNoticeComponent {
  readonly email = input<string | undefined>();
  protected readonly shell = inject(SHELL_STORE);

  protected leave(): void {
    void this.shell.logout();
  }
}
