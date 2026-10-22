import { InjectionToken } from '@angular/core';
import { createUiCore, type UiCore } from '@swag/ui-core';
import { swarmStream, swarmsApi } from './api.ts';

// Логика UI из @swag/ui-core; компоненты получают её через токен.
export const UI = new InjectionToken<UiCore>('ui-core', {
  factory: () =>
    createUiCore({
      api: swarmsApi,
      stream: swarmStream,
      timers: {
        setTimeout: (fn, ms) => window.setTimeout(fn, ms),
        clearTimeout: (id) => window.clearTimeout(id as number),
      },
    }),
});

export const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));
