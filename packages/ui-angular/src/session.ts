import { computed, inject, Injectable, InjectionToken, signal, type Signal } from '@angular/core';
import { AuthMe, type Role } from '@swag/contracts';
import { createAuthSessionKeeper, type AuthSessionKeeper } from '@swag/ui-core';
import { authApi, getMe } from './auth-api.ts';

// Спека 024, 4.15: один AuthSessionKeeper на приложение.
export const SESSION = new InjectionToken<AuthSessionKeeper>('auth-session', {
  factory: () => createAuthSessionKeeper(authApi),
});

// Спека 013, 4.11, решение D-130 (2026-11-01): роль и организация — из GET /auth/me, а не из claims токена
// (у пользователя может быть несколько организаций, D-131; токену не доверяем).
// Перечитывается при смене токена (вход, восстановление, renew), сбрасывается при выходе.
// Только для показа пунктов и форм: права проверяет API.
@Injectable({ providedIn: 'root' })
export class CurrentUser {
  private readonly session = inject(SESSION);
  private readonly meState = signal<AuthMe | null>(null);
  readonly me: Signal<AuthMe | null> = this.meState;
  private loadedToken: string | null = null;
  private pending: { token: string; done: Promise<void> } | null = null;
  private generation = 0;

  readonly role = computed<Role | null>(() => this.me()?.user.role ?? null);
  readonly orgId = computed<string | null>(() => this.me()?.organization?.id ?? null);

  // Нет токена — сброс. Токен совпадает с уже загруженным — ничего не делается.
  ensure(): Promise<void> {
    const token = this.session.accessToken();
    if (token === null) {
      this.clear();
      return Promise.resolve();
    }
    if (token === this.loadedToken) return Promise.resolve();
    if (this.pending?.token !== token) {
      this.pending = { token, done: this.load(token) };
    }
    return this.pending.done;
  }

  clear(): void {
    this.generation += 1;
    this.loadedToken = null;
    this.pending = null;
    this.meState.set(null);
  }

  // Трактовка: 401 — один renew и повтор; любая неудача или неразобранный ответ — пользователь неизвестен.
  private async load(token: string): Promise<void> {
    const generation = this.generation;
    let current = token;
    let result: AuthMe | null;
    try {
      let response = await getMe(current);
      if (response.status === 401 && (await this.session.renew())) {
        current = this.session.accessToken() ?? current;
        response = await getMe(current);
      }
      const body: unknown = response.ok ? await response.json() : null;
      const parsed = AuthMe.safeParse(body);
      result = parsed.success ? parsed.data : null;
    } catch {
      result = null;
    }
    if (generation !== this.generation) return;
    this.loadedToken = current;
    this.meState.set(result);
  }
}
