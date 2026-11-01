import type { Routes } from '@angular/router';
import { provideAdminStore } from '@swag/ui-angular';
import { UsersPageComponent } from './users.page.ts';

// Спека 014, 4.4 и REQ-014-11: экспорт `./routes` для каркаса. Префикс `admin` задаёт каркас; без `**`, guard — в каркасе.
// Спека 014, REQ-014-12 и 4.12: `ADMIN_STORE` собирается здесь и живёт сессию вкладки (решение человека, 2026-11-01).
export const routes: Routes = [
  {
    path: '',
    providers: [provideAdminStore()],
    children: [
      { path: 'users', component: UsersPageComponent },
      { path: '', pathMatch: 'full', redirectTo: 'users' },
    ],
  },
];
