import type { ServiceInfo } from '@swag/contracts';

export interface ApiCoreDeps {
  version: string; // передаёт оболочка: ядро не читает package.json
}

export interface ApiCore {
  info(): ServiceInfo;
}

export function createApiCore(deps: ApiCoreDeps): ApiCore {
  return {
    info: () => ({ service: 'api', version: deps.version }),
  };
}
