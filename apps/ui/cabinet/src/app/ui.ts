import { InjectionToken } from '@angular/core';
import { createUiCore, type UiCore } from '@swag/ui-core';
import { swarmStream, swarmsApi } from './api.ts';

// Спека 016, Q-6 и 4.10: Grafana за прокси `ng serve` на /grafana, ссылка относительная.
// Explore с источником Tempo (uid `tempo` в grafana/otel-lgtm) и запросом по traceId.
const TRACE_SLOT = '__TRACE_ID__';
const explorePanes = JSON.stringify({
  trace: {
    datasource: 'tempo',
    queries: [
      {
        refId: 'A',
        datasource: { type: 'tempo', uid: 'tempo' },
        queryType: 'traceql',
        query: TRACE_SLOT,
      },
    ],
    range: { from: 'now-7d', to: 'now' },
  },
});
export const TRACE_URL_TEMPLATE = `/grafana/explore?schemaVersion=1&orgId=1&panes=${encodeURIComponent(
  explorePanes,
)
  .split(TRACE_SLOT)
  .join('{traceId}')}`;

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
      traces: { urlTemplate: TRACE_URL_TEMPLATE },
    }),
});

export const errorText = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);
