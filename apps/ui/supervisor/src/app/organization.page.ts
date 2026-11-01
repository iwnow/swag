import { ChangeDetectionStrategy, Component, inject, Input } from '@angular/core';
import {
  AlertComponent,
  BalancePanelComponent,
  PageComponent,
  SUPERVISOR_STORE,
  UserTableComponent,
} from '@swag/ui-angular';
import { authErrorText } from '@swag/ui-core';

// Спека 014, REQ-014-13 и 4.12: страница организации. `orgId` приходит входом маршрута (`withComponentInputBinding`):
// сеттер запускает загрузку при каждом заходе и при смене id, подписок и effect нет.
// Логика — в `SupervisorStore`, страница только рисует.

@Component({
  selector: 'app-organization-page',
  imports: [AlertComponent, BalancePanelComponent, PageComponent, UserTableComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (store.notFound()) {
      <swag-alert kind="error">{{ notFoundText }}</swag-alert>
    } @else {
      <swag-page [title]="store.organization()?.name ?? ''">
        @if (store.error(); as message) {
          <swag-alert kind="error">{{ message }}</swag-alert>
        }
        <swag-user-table
          [rows]="store.rows()"
          [loaded]="store.usersLoaded()"
          (action)="store.apply($event.userId, $event.action)"
        />
        <swag-balance-panel
          [state]="store.balance"
          (more)="store.balance.more()"
          (topup)="store.topup($event)"
        />
      </swag-page>
    }
  `,
})
export class OrganizationPageComponent {
  protected readonly store = inject(SUPERVISOR_STORE);
  protected readonly notFoundText = authErrorText('not_found');

  constructor() {
    void this.store.loadOrganizations();
  }

  @Input() set orgId(id: string) {
    void this.store.openOrganization(id);
  }
}
