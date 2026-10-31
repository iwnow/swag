import type { Routes } from '@angular/router';
import { authGuard } from './auth.guard.ts';
import { LoginPageComponent } from './login.page.ts';
import { SwarmListPageComponent } from './swarm-list.page.ts';
import { SwarmNewPageComponent } from './swarm-new.page.ts';
import { SwarmPageComponent } from './swarm.page.ts';

// Спека 001, 4.8: `/` — список, `/swarms/new` — форма, `/swarms/:id` — страница роя.
// Спека 024, 4.15: `/login` — вход; маршруты роёв защищены guard.
export const routes: Routes = [
  { path: 'login', component: LoginPageComponent },
  {
    path: '',
    canActivate: [authGuard],
    children: [
      { path: '', component: SwarmListPageComponent },
      { path: 'swarms/new', component: SwarmNewPageComponent },
      { path: 'swarms/:id', component: SwarmPageComponent },
    ],
  },
  { path: '**', redirectTo: '' },
];
