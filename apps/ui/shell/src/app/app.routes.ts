import type { Routes } from '@angular/router';
import { areaGuard, sessionGuard } from '@swag/ui-angular';
import { LayoutComponent } from './layout.ts';
import { LoginPageComponent } from './login.page.ts';
import { loadRoutes } from './remote-registry.ts';

// Спека 014, 4.4. Маршруты /signup, /signup/confirm и /invite добавляет T-14 (D-144).
// Остальное — под сессией; раздел remote загружается только при доступе (REQ-014-3).
export const routes: Routes = [
  { path: 'login', component: LoginPageComponent },
  {
    path: '',
    canMatch: [sessionGuard],
    component: LayoutComponent,
    children: [
      { path: 'admin', canMatch: [areaGuard('admin')], loadChildren: () => loadRoutes('admin') },
      {
        path: 'supervisor',
        canMatch: [areaGuard('supervisor')],
        loadChildren: () => loadRoutes('supervisor'),
      },
      { path: '', loadChildren: () => loadRoutes('cabinet') },
    ],
  },
  { path: '**', redirectTo: '' },
];
