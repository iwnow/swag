import { effect, Signal as PreactSignal, type ReadonlySignal } from '@preact/signals-core';
import {
  DestroyRef,
  inject,
  InjectionToken,
  signal,
  untracked,
  type Provider,
  type Signal,
} from '@angular/core';
import {
  createCabinetStore,
  createSessionUserStore,
  createShellStore,
  type CabinetStore,
  type SessionUserStore,
  type ShellStore,
  type Timers,
} from '@swag/ui-core';
import { authApi, meApi } from './auth-api.ts';
import { createBalanceApi } from './balance-api.ts';
import { preferences } from './preferences.ts';
import { createSwarmsApi, createSwarmStream } from './swarms-api.ts';

// Спека 014, 4.12 «Мост в Angular»: сторы ui-core (preact signals) → Angular-сигналы.

export type Connected<S> = {
  readonly [K in keyof S]: S[K] extends ReadonlySignal<infer V>
    ? Signal<V>
    : S[K] extends (...args: infer A) => infer R
      ? (...args: A) => R
      : S[K] extends object
        ? Connected<S[K]>
        : S[K];
};

export function toAngularSignal<T>(source: ReadonlySignal<T>, destroyRef: DestroyRef): Signal<T> {
  const bridged = signal(source.peek());
  const stop = untracked(() =>
    effect(() => {
      bridged.set(source.value);
    }),
  );
  destroyRef.onDestroy(stop);
  return bridged.asReadonly();
}

const readOnly = (): never => {
  throw new TypeError('connectStore: стор доступен только для чтения');
};

// Вложенный мост — только для простого объекта; массивы, Date и прочее отдаются как есть.
function isPlainObject(value: unknown): value is object {
  if (typeof value !== 'object' || value === null) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

export function connectStore<S extends object>(
  store: S,
  destroyRef: DestroyRef = inject(DestroyRef),
): Connected<S> {
  const cache = new Map<PropertyKey, unknown>();
  return new Proxy(store, {
    get(target, key) {
      if (cache.has(key)) return cache.get(key);
      const value: unknown = Reflect.get(target, key, target);
      let bridged: unknown;
      if (value instanceof PreactSignal) bridged = toAngularSignal(value, destroyRef);
      else if (typeof value === 'function') bridged = value.bind(target);
      else if (isPlainObject(value)) bridged = connectStore(value, destroyRef);
      else return value;
      cache.set(key, bridged);
      return bridged;
    },
    set: readOnly,
    defineProperty: readOnly,
    deleteProperty: readOnly,
  }) as Connected<S>;
}

const timers: Timers = {
  setTimeout: (fn, ms) => window.setTimeout(fn, ms),
  clearTimeout: (id) => window.clearTimeout(id as number),
};

// Спека 016, Q-6 и 4.10 (перенесено из apps/ui/cabinet/src/app/ui.ts, спека 014, REQ-014-23).
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

export const SESSION_USER = new InjectionToken<SessionUserStore>('session-user-store', {
  providedIn: 'root',
  factory: () => createSessionUserStore({ auth: authApi, me: meApi }),
});

export const SHELL_STORE = new InjectionToken<Connected<ShellStore>>('shell-store');
export const CABINET_STORE = new InjectionToken<Connected<CabinetStore>>('cabinet-store');

export function provideShellStore(): Provider[] {
  return [
    {
      provide: SHELL_STORE,
      useFactory: () =>
        connectStore(createShellStore({ session: inject(SESSION_USER), preferences })),
    },
  ];
}

export function provideCabinetStore(): Provider[] {
  return [
    {
      provide: CABINET_STORE,
      useFactory: () => {
        const session = inject(SESSION_USER);
        const destroyRef = inject(DestroyRef);
        const store = createCabinetStore({
          session,
          swarms: createSwarmsApi(session),
          stream: createSwarmStream(session),
          timers,
          traces: { urlTemplate: TRACE_URL_TEMPLATE },
          balance: createBalanceApi(session),
        });
        destroyRef.onDestroy(() => store.dispose());
        return connectStore(store, destroyRef);
      },
    },
  ];
}
