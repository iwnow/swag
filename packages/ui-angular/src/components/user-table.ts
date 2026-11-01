import { ChangeDetectionStrategy, Component, input, output, signal } from '@angular/core';
import type { ManagedUser } from '@swag/contracts';
import {
  blockConfirmText,
  formatDateTime,
  USER_ACTION_LABEL,
  USER_ROLE_LABEL,
  type UserAction,
  type UserRow,
} from '@swag/ui-core';
import { ButtonDirective } from './button.ts';
import { ConfirmComponent } from './confirm.ts';
import { TableComponent } from './table.ts';

// Спека 014, 4.6 и REQ-014-12/13: таблица пользователей админки и супервизора. Состояние — только открытое
// подтверждение блокировки; действия выполняет стор, таблица отдаёт `action` наружу.
@Component({
  selector: 'swag-user-table',
  imports: [ButtonDirective, ConfirmComponent, TableComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <swag-table [empty]="loaded() ? 'Пользователей пока нет.' : ''">
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
          @for (row of rows(); track row.user.id) {
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
        [text]="confirmText(user.email)"
        (confirmed)="confirmBlock(user)"
        (cancelled)="pending.set(null)"
      />
    }
  `,
})
export class UserTableComponent {
  readonly rows = input.required<UserRow[]>();
  readonly loaded = input.required<boolean>();
  readonly action = output<{ userId: string; action: UserAction }>();

  protected readonly pending = signal<ManagedUser | null>(null);
  protected readonly roleLabel = USER_ROLE_LABEL;
  protected readonly actionLabel = USER_ACTION_LABEL;
  protected readonly formatDate = formatDateTime;
  protected readonly confirmText = blockConfirmText;

  protected act(user: ManagedUser, action: UserAction): void {
    if (action === 'block') {
      this.pending.set(user);
      return;
    }
    this.action.emit({ userId: user.id, action });
  }

  protected confirmBlock(user: ManagedUser): void {
    this.pending.set(null);
    this.action.emit({ userId: user.id, action: 'block' });
  }
}
