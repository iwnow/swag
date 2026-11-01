import type {
  AuthMe,
  BalanceEntry,
  BalanceEntryList,
  BalanceView,
  TopupRequest,
} from '@swag/contracts';

// Спека 014, 4.12: порты сторов UI, которых нет в 4.1 и 4.3.

export interface BalanceApi {
  getBalance(orgId: string): Promise<BalanceView>;
  listBalanceEntries(orgId: string, before: number | null): Promise<BalanceEntryList>;
  topup(orgId: string, body: TopupRequest): Promise<BalanceEntry>;
}

export interface MeApi {
  me(accessToken: string): Promise<AuthMe | null>; // GET /auth/me; null — 401
}

export interface Preferences {
  get(key: string): string | null; // ошибка хранилища — null
  set(key: string, value: string): void; // ошибка хранилища — молча
}
