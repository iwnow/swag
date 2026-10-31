import type { OrgDirectory } from '@swag/billing-core';

// Спека 013, 4.9: справочник организаций через identity. Сбой связи, таймаут и неожиданный статус — исключение.
export function createOrgDirectory(options: {
  identityUrl: string;
  token: string;
  timeoutMs: number;
}): OrgDirectory {
  return {
    async exists(orgId: string): Promise<boolean> {
      const response = await fetch(
        new URL(`/internal/organizations/${encodeURIComponent(orgId)}`, options.identityUrl),
        {
          headers: { authorization: `Bearer ${options.token}` },
          signal: AbortSignal.timeout(options.timeoutMs),
        },
      );
      if (response.status === 204) return true;
      if (response.status === 404) return false;
      await response.body?.cancel();
      throw new Error(`identity organizations: HTTP ${response.status}`);
    },
  };
}
