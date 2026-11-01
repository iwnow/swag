import { ApplicationConfig, provideBrowserGlobalErrorListeners } from '@angular/core';
import {
  provideRouter,
  withAutoCleanupInjectors,
  withComponentInputBinding,
} from '@angular/router';
import { provideShellStore } from '@swag/ui-angular';
import { routes } from './app.routes.ts';

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    provideRouter(routes, withComponentInputBinding(), withAutoCleanupInjectors()),
    provideShellStore(),
  ],
};
