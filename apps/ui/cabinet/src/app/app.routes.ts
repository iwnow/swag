import type { Routes } from '@angular/router';
import { areaGuard, provideCabinetStore } from '@swag/ui-angular';
import { BalancePageComponent } from './balance.page.ts';
import { SwarmListPageComponent } from './swarm-list.page.ts';
import { SwarmNewPageComponent } from './swarm-new.page.ts';
import { SwarmPageComponent } from './swarm.page.ts';

// Спека 014, 4.4 и REQ-014-11: экспорт `./routes` для каркаса. Префикс `''`, без `**` — неизвестный путь уходит к каркасу.
// Спека 001, 4.8: `/` — список, `/swarms/new` — форма, `/swarms/:id` — страница роя.
// Спека 013, 4.11: `/balance` — баланс организации.
// Спека 014, 4.12 и T-25: `CABINET_STORE` собирается здесь, а не в корне приложения.
export const routes: Routes = [
  {
    path: '',
    providers: [provideCabinetStore()],
    children: [
      { path: '', canMatch: [areaGuard('swarms')], component: SwarmListPageComponent },
      { path: 'swarms/new', canMatch: [areaGuard('swarms')], component: SwarmNewPageComponent },
      { path: 'swarms/:id', canMatch: [areaGuard('swarms')], component: SwarmPageComponent },
      { path: 'balance', canMatch: [areaGuard('balance')], component: BalancePageComponent },
    ],
  },
];
