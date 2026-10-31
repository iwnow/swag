import { z } from 'zod';
import { OrgId, UserId } from './auth.ts';
import { MicroUsd } from './llm.ts';
import { SwarmId } from './swarm.ts';

// Спека 013, 4.1. Сумма одного пополнения. Рабочий предел — BALANCE_MAX_TOPUP_MICRO_USD (013, 4.10).
export const TopupMicroUsd = z.number().int().min(1).max(1_000_000_000); // до $1000

export const TopupRequest = z.strictObject({
  amountMicroUsd: TopupMicroUsd,
  comment: z.string().trim().min(1).max(500).nullable().default(null), // пустая строка не проходит: форма шлёт null; супервизору обязателен (013, 4.3)
});

export const BalanceView = z.strictObject({
  orgId: OrgId,
  balanceMicroUsd: MicroUsd, // сумма записей журнала
  heldMicroUsd: MicroUsd, // резервы роёв, которые ещё идут
  availableMicroUsd: MicroUsd, // balance − held
});

export const BalanceEntryKind = z.enum(['topup', 'swarm']);

export const BalanceEntry = z.strictObject({
  id: z.number().int().positive(), // порядковый номер записи, общий на все организации (Q-6)
  orgId: OrgId,
  ts: z.iso.datetime(),
  kind: BalanceEntryKind,
  amountMicroUsd: z.number().int().min(-Number.MAX_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER), // topup > 0, swarm ≤ 0
  swarmId: SwarmId.nullable(), // только у swarm
  actorId: UserId.nullable(), // кто пополнил; у swarm — null
  comment: z.string().nullable(),
});

export const BalanceEntryList = z.strictObject({
  entries: z.array(BalanceEntry), // от новых к старым
  nextBefore: z.number().int().positive().nullable(), // id для следующей страницы; null — страниц больше нет
});

export type TopupMicroUsd = z.infer<typeof TopupMicroUsd>;
export type TopupRequest = z.infer<typeof TopupRequest>;
export type BalanceView = z.infer<typeof BalanceView>;
export type BalanceEntryKind = z.infer<typeof BalanceEntryKind>;
export type BalanceEntry = z.infer<typeof BalanceEntry>;
export type BalanceEntryList = z.infer<typeof BalanceEntryList>;
