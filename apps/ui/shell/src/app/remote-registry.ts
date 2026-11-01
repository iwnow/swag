import { loadRemoteModule } from '@angular-architects/native-federation';
import { inject, Injectable } from '@angular/core';
import type { Routes } from '@angular/router';
import { isLocalRemoteUrl } from '@swag/ui-core';

// Спека 014, 4.4: адреса remote из манифеста каркаса. Записи с чужим адресом отбрасываются.
// Сервис DI: `loadChildren` в Angular 22 вызывается в injection context родительского инжектора.
@Injectable({ providedIn: 'root' })
export class RemoteRegistry {
  private readonly urls = new Map<string, string>();
  private reading: Promise<void> | null = null;

  load(): Promise<void> {
    this.reading ??= this.readManifest();
    return this.reading;
  }

  async url(name: string): Promise<string | undefined> {
    await this.load();
    return this.urls.get(name);
  }

  // Ошибка чтения или разбора сбрасывает кэш: следующая навигация пробует манифест снова.
  private async readManifest(): Promise<void> {
    let manifest: unknown;
    try {
      const response = await fetch('/federation.manifest.json');
      if (!response.ok) throw new Error(`manifest_http_${response.status}`);
      manifest = await response.json();
      if (typeof manifest !== 'object' || manifest === null) throw new Error('manifest_shape');
    } catch {
      this.reading = null;
      return;
    }
    for (const [name, url] of Object.entries(manifest)) {
      if (typeof url === 'string' && isLocalRemoteUrl(url)) this.urls.set(name, url);
      else console.warn('remote_rejected', name);
    }
  }
}

// Спека 014, 4.4: remote загружается только здесь, то есть при переходе в раздел.
// Вызывается в injection context `loadChildren`, поэтому RemoteRegistry берётся через inject до первого await.
// Имени нет в реестре — ошибка загрузки маршрута; каркас показывает «Раздел недоступен».
export async function loadRoutes(name: string): Promise<Routes> {
  const registry = inject(RemoteRegistry);
  const remoteEntry = await registry.url(name);
  if (remoteEntry === undefined) throw new Error(`remote_not_registered: ${name}`);
  const module = (await loadRemoteModule({ remoteEntry, exposedModule: './routes' })) as {
    routes: Routes;
  };
  return module.routes;
}
