import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import {
  BalancePanelComponent,
  CABINET_STORE,
  connectStore,
  PageComponent,
  SESSION_USER,
} from '@swag/ui-angular';

// Спека 013, 4.11 и 014, 4.12: страница «Баланс» рисует `CabinetStore.balance`; организация — из SESSION_USER.
// Комментарий пополнения в кабинете не обязателен (`requireComment` = false).
// Данные перечитываются при каждом заходе: конструктор страницы выполняется заново на каждый переход.
@Component({
  selector: 'app-balance-page',
  imports: [BalancePanelComponent, PageComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <swag-page title="Баланс">
      <swag-balance-panel
        [state]="cabinet.balance"
        (more)="cabinet.balance.more()"
        (topup)="onTopup($event)"
      />
    </swag-page>
  `,
})
export class BalancePageComponent {
  protected readonly cabinet = inject(CABINET_STORE);
  private readonly session = connectStore(inject(SESSION_USER));

  constructor() {
    void this.cabinet.balance.open(this.session.orgId());
  }

  protected onTopup(input: { amountUsd: string; comment: string }): void {
    void this.cabinet.balance.topup(input, false);
  }
}
