import type { Routes } from '@angular/router';
import { provideSupervisorStore } from '@swag/ui-angular';
import { OrganizationPageComponent } from './organization.page.ts';
import { OrganizationsPageComponent } from './organizations.page.ts';

// Спека 014, 4.4 и REQ-014-13: экспорт `./routes` для каркаса. Префикс `supervisor` задаёт каркас; без `**`, guard — в каркасе.
// Спека 014, REQ-014-12 и 4.12: `SUPERVISOR_STORE` собирается здесь и живёт сессию вкладки (решение человека, 2026-11-01).
export const routes: Routes = [
  {
    path: '',
    providers: [provideSupervisorStore()],
    children: [
      { path: '', pathMatch: 'full', component: OrganizationsPageComponent },
      { path: 'organizations/:orgId', component: OrganizationPageComponent },
    ],
  },
];
