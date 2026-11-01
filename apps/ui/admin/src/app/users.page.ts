import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import type { InvitationRequest } from '@swag/contracts';
import {
  ADMIN_STORE,
  AlertComponent,
  ButtonDirective,
  CardComponent,
  FieldComponent,
  PageComponent,
  UserTableComponent,
} from '@swag/ui-angular';
import { USER_ROLE_LABEL } from '@swag/ui-core';

// Спека 014, REQ-014-12 и 4.6: страница пользователей организации. Логика — в `AdminStore`, страница только рисует.

@Component({
  selector: 'app-users-page',
  imports: [
    AlertComponent,
    ButtonDirective,
    CardComponent,
    FieldComponent,
    PageComponent,
    UserTableComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <swag-page title="Пользователи">
      @if (store.error(); as message) {
        <swag-alert kind="error">{{ message }}</swag-alert>
      }
      <swag-user-table
        [rows]="store.rows()"
        [loaded]="store.loaded()"
        (action)="store.apply($event.userId, $event.action)"
      />

      <swag-card title="Пригласить пользователя">
        @if (store.invite().sent; as sent) {
          <swag-alert kind="success">{{ sent }}</swag-alert>
        }
        <form (submit)="send($event, email.value, role.value)">
          <swag-field label="Email" [error]="emailError()">
            <input #email type="email" autocomplete="off" />
          </swag-field>
          <swag-field label="Роль">
            <select #role>
              @for (option of roles; track option) {
                <option [value]="option">{{ roleLabel[option] }}</option>
              }
            </select>
          </swag-field>
          <button swag-button type="submit" [busy]="store.invite().busy">Пригласить</button>
        </form>
        @if (store.invite().error; as message) {
          <swag-alert kind="error">{{ message }}</swag-alert>
        }
      </swag-card>
    </swag-page>
  `,
})
export class UsersPageComponent {
  protected readonly store = inject(ADMIN_STORE);
  protected readonly roles: InvitationRequest['role'][] = ['user', 'admin'];
  protected readonly roleLabel = USER_ROLE_LABEL;

  constructor() {
    this.store.resetInvite();
    void this.store.load();
  }

  protected send(event: Event, email: string, role: string): void {
    event.preventDefault();
    void this.store.sendInvite(email, role as InvitationRequest['role']);
  }

  protected emailError(): string | null {
    return this.store.invite().issues.find((issue) => issue.path === 'email')?.message ?? null;
  }
}
