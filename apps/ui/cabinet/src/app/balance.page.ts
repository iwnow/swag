import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { BalancePanelComponent, CurrentUser, PageComponent } from '@swag/ui-angular';

// Спека 013, 4.11 и 014, 4.11: страница «Баланс» — обёртка над `swag-balance-panel` с `orgId` из `CurrentUser`.
// Комментарий пополнения в кабинете не обязателен (`requireComment` = false).
@Component({
  selector: 'app-balance-page',
  imports: [BalancePanelComponent, PageComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <swag-page title="Баланс">
      <swag-balance-panel [orgId]="orgId()" [requireComment]="false" />
    </swag-page>
  `,
})
export class BalancePageComponent {
  readonly orgId = inject(CurrentUser).orgId;
}
