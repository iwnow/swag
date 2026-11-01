import type { Routes } from '@angular/router';
import { areaGuard, sessionGuard } from '@swag/ui-angular';
import { InvitePageComponent } from './invite.page.ts';
import { LayoutComponent } from './layout.ts';
import { LoginPageComponent } from './login.page.ts';
import { loadRoutes } from './remote-registry.ts';
import { SignupConfirmPageComponent } from './signup-confirm.page.ts';
import { SignupPageComponent } from './signup.page.ts';

// Спека 014, 4.4 и 4.11. Страницы регистрации и приглашения — вне sessionGuard (REQ-014-6…9).
// Остальное — под сессией; раздел remote загружается только при доступе (REQ-014-3).
export const routes: Routes = [
  { path: 'login', component: LoginPageComponent },
  { path: 'signup', component: SignupPageComponent },
  { path: 'signup/confirm', component: SignupConfirmPageComponent },
  { path: 'invite', component: InvitePageComponent },
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
