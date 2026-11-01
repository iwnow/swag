import {
  createEnvironmentInjector,
  Injector,
  runInInjectionContext,
  type EnvironmentInjector,
} from '@angular/core';
import { effect, signal } from '@preact/signals-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { connectStore } from '../src/stores.ts';
import { preferences } from '../src/preferences.ts';

vi.mock('@preact/signals-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@preact/signals-core')>();
  return { ...actual, effect: vi.fn(actual.effect) };
});

function makeStore() {
  return {
    count: signal(1),
    balance: { loaded: signal(false) },
    inc() {
      this.count.value += 1;
    },
  };
}

function makeInjector(): EnvironmentInjector {
  return createEnvironmentInjector([], Injector.create({ providers: [] }) as EnvironmentInjector);
}

beforeEach(() => {
  vi.mocked(effect).mockClear();
});

describe('connectStore', () => {
  it('AC-014-26: значение сменилось в сторе — count() и balance.loaded() отдают новое', () => {
    const store = makeStore();
    const injector = makeInjector();
    const connected = runInInjectionContext(injector, () => connectStore(store));

    store.count.value = 5;
    store.balance.loaded.value = true;

    expect(connected.count()).toBe(5);
    expect(connected.balance.loaded()).toBe(true);
  });

  it('AC-014-26: поле-сигнал, добавленное в стор после моста, читается без правки моста', () => {
    const store = makeStore();
    const injector = makeInjector();
    const connected = runInInjectionContext(injector, () => connectStore(store));

    Object.assign(store, { extra: signal('hi') });

    expect((connected as unknown as { extra: () => string }).extra()).toBe('hi');
  });

  it('AC-014-26: повторное чтение поля — тот же объект и один effect', () => {
    const store = makeStore();
    const injector = makeInjector();
    const connected = runInInjectionContext(injector, () => connectStore(store));

    const first = connected.count;
    const second = connected.count;

    expect(second).toBe(first);
    expect(vi.mocked(effect)).toHaveBeenCalledTimes(1);
  });

  it('AC-014-26: метод стора работает с this стора', () => {
    const store = makeStore();
    const injector = makeInjector();
    const connected = runInInjectionContext(injector, () => connectStore(store));
    const count = connected.count;

    connected.inc();

    expect(store.count.value).toBe(2);
    expect(count()).toBe(2);
  });

  it('AC-014-26: запись в мост бросает TypeError', () => {
    const store = makeStore();
    const injector = makeInjector();
    const connected = runInInjectionContext(injector, () => connectStore(store));

    expect(() => Reflect.set(connected, 'count', 9)).toThrow(TypeError);
    expect(() => Reflect.defineProperty(connected, 'count', { value: 9 })).toThrow(TypeError);
    expect(() => Reflect.deleteProperty(connected, 'count')).toThrow(TypeError);
  });

  it('AC-014-26: инжектор уничтожен, затем значение сменилось — Angular-сигнал прежний', () => {
    const store = makeStore();
    const injector = makeInjector();
    const connected = runInInjectionContext(injector, () => connectStore(store));
    const count = connected.count;
    expect(count()).toBe(1);

    injector.destroy();
    store.count.value = 42;

    expect(count()).toBe(1);
  });
});

describe('preferences', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('ошибка localStorage: get отдаёт null, set не бросает', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('denied');
      },
    });

    expect(preferences.get('swag.theme')).toBeNull();
    expect(() => preferences.set('swag.theme', 'dark')).not.toThrow();
  });

  it('localStorage доступен: get возвращает сохранённое значение', () => {
    const data = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => data.get(key) ?? null,
      setItem: (key: string, value: string) => data.set(key, value),
    });

    preferences.set('swag.theme', 'light');

    expect(preferences.get('swag.theme')).toBe('light');
  });
});
