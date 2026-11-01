import { loadRemoteModule } from '@angular-architects/native-federation';
import type { Routes } from '@angular/router';
import { isLocalRemoteUrl } from '@swag/ui-core';

// Спека 014, 4.4: адреса remote из манифеста каркаса. Записи с чужим адресом отбрасываются.
// Не сервис DI (D-140): `loadChildren` вызывается без инжектора, поэтому реестр — один экземпляр модуля.
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

  private async readManifest(): Promise<void> {
    let manifest: unknown;
    try {
      manifest = await (await fetch('/federation.manifest.json')).json();
    } catch {
      console.warn('manifest_unavailable');
      return;
    }
    if (typeof manifest !== 'object' || manifest === null) return;
    for (const [name, url] of Object.entries(manifest)) {
      if (typeof url === 'string' && isLocalRemoteUrl(url)) this.urls.set(name, url);
      else console.warn('remote_rejected', name);
    }
  }
}

export const remoteRegistry = new RemoteRegistry();

// Спека 014, 4.4: remote загружается только здесь, то есть при переходе в раздел.
// Имени нет в реестре — ошибка загрузки маршрута; каркас показывает «Раздел недоступен».
export async function loadRoutes(name: string): Promise<Routes> {
  const remoteEntry = await remoteRegistry.url(name);
  if (remoteEntry === undefined) throw new Error(`remote_not_registered: ${name}`);
  const module = (await loadRemoteModule({ remoteEntry, exposedModule: './routes' })) as {
    routes: Routes;
  };
  return module.routes;
}
