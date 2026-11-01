import '@angular/compiler';
import {
  createEnvironmentInjector,
  effect,
  Injector,
  runInInjectionContext,
  type EnvironmentInjector,
} from '@angular/core';
import { DefaultUrlSerializer, Router } from '@angular/router';
import { signal } from '@preact/signals-core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { redirectOnSignOut } from '../src/guards.ts';
import { SESSION_USER } from '../src/stores.ts';

// Без DOM эффект Angular не запускается сам: тест берёт его колбэк и вызывает вручную.
vi.mock('@angular/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@angular/core')>();
  return { ...actual, effect: vi.fn() };
});

// Роутер-заглушка: `navigated` — завершена ли первая навигация, текущий адрес — `url`; разбор адреса — настоящий сериализатор.
function signOutAt(
  url: string,
  {
    navigated = true,
    to = 'signed-out',
  }: { navigated?: boolean; to?: 'signed-in' | 'signed-out' } = {},
) {
  const status = signal<'signed-in' | 'signed-out'>('signed-in');
  const navigateByUrl = vi.fn();
  const parseUrl = (value: string) => new DefaultUrlSerializer().parse(value);
  const injector = createEnvironmentInjector(
    [
      { provide: Router, useValue: { navigated, url, parseUrl, navigateByUrl } },
      { provide: SESSION_USER, useValue: { status } },
    ],
    Injector.create({ providers: [] }) as EnvironmentInjector,
  );
  runInInjectionContext(injector, () => redirectOnSignOut());
  const onStatusChange = vi.mocked(effect).mock.calls[0]?.[0] as () => void;

  status.value = to;
  onStatusChange();
  return navigateByUrl;
}

afterEach(() => {
  vi.mocked(effect).mockClear();
});

describe('redirectOnSignOut', () => {
  it.each([
    '/signup',
    '/signup/confirm',
    '/invite',
    '/invite?token=abc',
    '/login?returnTo=%2Fx',
    '/signup#top',
  ])('REQ-014-9: выход на открытой странице %s — перехода на /login нет', (url) => {
    expect(signOutAt(url)).not.toHaveBeenCalled();
  });

  it('REQ-014-9: выход на закрытой странице — переход на /login', () => {
    expect(signOutAt('/swarms/x')).toHaveBeenCalledWith('/login');
  });

  it('REQ-014-9: путь с открытым префиксом, но другим сегментом (/invitex) — переход на /login', () => {
    expect(signOutAt('/invitex')).toHaveBeenCalledWith('/login');
  });

  it('REQ-014-9: до первой навигации роутера (navigated = false) — перехода нет', () => {
    expect(signOutAt('/swarms/x', { navigated: false })).not.toHaveBeenCalled();
  });

  it('REQ-014-9: переход в signed-in — перехода на /login нет', () => {
    expect(signOutAt('/swarms/x', { to: 'signed-in' })).not.toHaveBeenCalled();
  });
});
