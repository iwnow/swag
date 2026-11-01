import { inject, InjectionToken } from '@angular/core';
import { createUiCore, type UiCore } from '@swag/ui-core';
import {
  createBalanceApi,
  createSwarmStream,
  createSwarmsApi,
  SESSION_USER,
  TRACE_URL_TEMPLATE,
  type BalanceApi,
} from '@swag/ui-angular';

// Логика UI из @swag/ui-core; компоненты получают её через токен.
export const UI = new InjectionToken<UiCore>('ui-core', {
  factory: () => {
    const session = inject(SESSION_USER);
    return createUiCore({
      api: createSwarmsApi(session),
      stream: createSwarmStream(session),
      timers: {
        setTimeout: (fn, ms) => window.setTimeout(fn, ms),
        clearTimeout: (id) => window.clearTimeout(id as number),
      },
      traces: { urlTemplate: TRACE_URL_TEMPLATE },
    });
  },
});

// Спека 013, 4.11: адаптер баланса (REST по `/api`), тот же токен сессии.
export const BALANCE = new InjectionToken<BalanceApi>('balance-api', {
  factory: () => createBalanceApi(inject(SESSION_USER)),
});

export const errorText = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);
