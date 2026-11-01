import type { BalanceEntry, BalanceEntryList, BalanceView, TopupRequest } from '@swag/contracts';
import { createRequest, type RequestSession } from './http.ts';

// Спека 013, 4.11: баланс организации — тот же способ токена и разбора ошибок, что у `/api/swarms`.
export function createBalanceApi(session: RequestSession) {
  const request = createRequest(session, '/api');
  return {
    getBalance: (orgId: string) =>
      request<BalanceView>('GET', `/organizations/${encodeURIComponent(orgId)}/balance`),
    listBalanceEntries: (orgId: string, before: number | null) => {
      const query = before === null ? '' : `?before=${before}`;
      return request<BalanceEntryList>(
        'GET',
        `/organizations/${encodeURIComponent(orgId)}/balance/entries${query}`,
      );
    },
    topup: (orgId: string, body: TopupRequest) =>
      request<BalanceEntry>(
        'POST',
        `/organizations/${encodeURIComponent(orgId)}/balance/topups`,
        body,
      ),
  };
}

export type BalanceApi = ReturnType<typeof createBalanceApi>;
