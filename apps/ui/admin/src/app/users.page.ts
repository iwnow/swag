import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import type { InvitationRequest, ManagedUser } from '@swag/contracts';
import {
  ADMIN_STORE,
  AlertComponent,
  ButtonDirective,
  CardComponent,
  ConfirmComponent,
  FieldComponent,
  PageComponent,
  TableComponent,
} from '@swag/ui-angular';
import {
  blockConfirmText,
  formatDateTime,
  USER_ACTION_LABEL,
  USER_ROLE_LABEL,
  type UserAction,
} from '@swag/ui-core';

// Спека 014, REQ-014-12 и 4.6: страница пользователей организации. Логика — в `AdminStore`, страница только рисует.

@Component({
  selector: 'app-users-page',
  imports: [
    AlertComponent,
    ButtonDirective,
    CardComponent,
    ConfirmComponent,
    FieldComponent,
    PageComponent,
    TableComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <swag-page title="Пользователи">
      @if (store.error(); as message) {
        <swag-alert kind="error">{{ message }}</swag-alert>
      }
      <swag-table [empty]="store.loaded() ? 'Пользователей пока нет.' : ''">
        <table>
          <thead>
            <tr>
              <th>Email</th>
              <th>Роль</th>
              <th>Заблокирован</th>
              <th>Создан</th>
              <th>Действия</th>
            </tr>
          </thead>
          <tbody>
            @for (row of store.rows(); track row.user.id) {
              <tr>
                <td>{{ row.user.email }}</td>
                <td>{{ roleLabel[row.user.role] }}</td>
                <td>{{ row.user.blocked ? 'да' : 'нет' }}</td>
                <td>{{ formatDate(row.user.createdAt) }}</td>
                <td>
                  @for (action of row.actions; track action) {
                    <button
                      swag-button
                      variant="secondary"
                      type="button"
                      (click)="act(row.user, action)"
                    >
                      {{ actionLabel[action] }}
                    </button>
                  }
                </td>
              </tr>
            }
          </tbody>
        </table>
      </swag-table>

      @if (pending(); as user) {
        <swag-confirm
          [text]="confirmText(user)"
          (confirmed)="confirmBlock(user)"
          (cancelled)="pending.set(null)"
        />
      }

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
  protected readonly pending = signal<ManagedUser | null>(null);
  protected readonly roles: InvitationRequest['role'][] = ['user', 'admin'];
  protected readonly roleLabel = USER_ROLE_LABEL;
  protected readonly actionLabel = USER_ACTION_LABEL;
  protected readonly formatDate = formatDateTime;
  protected readonly confirmText = (user: ManagedUser): string => blockConfirmText(user.email);

  constructor() {
    this.store.resetInvite();
    void this.store.load();
  }

  protected act(user: ManagedUser, action: UserAction): void {
    if (action === 'block') {
      this.pending.set(user);
      return;
    }
    void this.store.apply(user.id, action);
  }

  protected confirmBlock(user: ManagedUser): void {
    this.pending.set(null);
    void this.store.apply(user.id, 'block');
  }

  protected send(event: Event, email: string, role: string): void {
    event.preventDefault();
    void this.store.sendInvite(email, role as InvitationRequest['role']);
  }

  protected emailError(): string | null {
    return this.store.invite().issues.find((issue) => issue.path === 'email')?.message ?? null;
  }
}
