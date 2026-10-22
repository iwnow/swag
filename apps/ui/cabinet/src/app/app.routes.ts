import type { Routes } from '@angular/router';
import { SwarmListPageComponent } from './swarm-list.page.ts';
import { SwarmNewPageComponent } from './swarm-new.page.ts';
import { SwarmPageComponent } from './swarm.page.ts';

// Спека 001, 4.8: `/` — список, `/swarms/new` — форма, `/swarms/:id` — страница роя.
export const routes: Routes = [
  { path: '', component: SwarmListPageComponent },
  { path: 'swarms/new', component: SwarmNewPageComponent },
  { path: 'swarms/:id', component: SwarmPageComponent },
  { path: '**', redirectTo: '' },
];
