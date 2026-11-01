import { batch, computed, signal, type ReadonlySignal } from '@preact/signals-core';
import {
  ROLE_PERMISSIONS,
  TopupRequest,
  type BalanceEntry,
  type BalanceView,
} from '@swag/contracts';
import { FORM_TEXT } from './auth-forms.ts';
import type { BalanceApi } from './ports.ts';
import type { SessionUserStore } from './session-user.store.ts';
import { usdToMicro } from './money.ts';

// Спека 014, 4.12 (логика панели баланса 013, 4.11 и 014, 4.7): состояние баланса организации без фреймворка.

export const TOPUP_INVALID_TEXT =
  'Проверьте сумму: от $0.000001 до $1000, комментарий до 500 символов.';

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export interface BalanceState {
  readonly orgId: ReadonlySignal<string | null>;
  readonly view: ReadonlySignal<BalanceView | null>;
  readonly entries: ReadonlySignal<BalanceEntry[]>;
  readonly nextBefore: ReadonlySignal<number | null>;
  readonly loaded: ReadonlySignal<boolean>;
  readonly loadingMore: ReadonlySignal<boolean>;
  readonly submitting: ReadonlySignal<boolean>;
  readonly error: ReadonlySignal<string | null>;
  readonly formError: ReadonlySignal<string | null>;
  readonly commentError: ReadonlySignal<string | null>;
  readonly canTopup: ReadonlySignal<boolean>;
  open(orgId: string | null): Promise<void>;
  more(): Promise<void>;
  topup(input: { amountUsd: string; comment: string }, requireComment: boolean): Promise<boolean>;
}

export function createBalanceState({
  session,
  balance,
}: {
  session: Pick<SessionUserStore, 'role'>;
  balance: BalanceApi;
}): BalanceState {
  const orgId = signal<string | null>(null);
  const view = signal<BalanceView | null>(null);
  const entries = signal<BalanceEntry[]>([]);
  const nextBefore = signal<number | null>(null);
  const loaded = signal(false);
  const loadingMore = signal(false);
  const submitting = signal(false);
  const error = signal<string | null>(null);
  const formError = signal<string | null>(null);
  const commentError = signal<string | null>(null);
  const canTopup = computed(() => {
    const role = session.role.value;
    return role !== null && ROLE_PERMISSIONS[role].includes('balance.topup');
  });

  // Номер последнего open: ответ от устаревшего запроса (другой орг или новый open) не записывается.
  let generation = 0;

  async function open(next: string | null): Promise<void> {
    const current = ++generation;
    batch(() => {
      orgId.value = next;
      view.value = null;
      entries.value = [];
      nextBefore.value = null;
      loadingMore.value = false;
      submitting.value = false;
      error.value = null;
      formError.value = null;
      commentError.value = null;
      loaded.value = false;
    });
    if (next === null) {
      loaded.value = true;
      return;
    }
    try {
      const [balanceView, page] = await Promise.all([
        balance.getBalance(next),
        balance.listBalanceEntries(next, null),
      ]);
      if (current !== generation) return;
      batch(() => {
        view.value = balanceView;
        entries.value = page.entries;
        nextBefore.value = page.nextBefore;
      });
    } catch (failure) {
      if (current !== generation) return;
      error.value = errorText(failure);
    } finally {
      if (current === generation) loaded.value = true;
    }
  }

  async function more(): Promise<void> {
    if (loadingMore.value) return;
    const id = orgId.value;
    const before = nextBefore.value;
    if (id === null || before === null) return;
    const current = generation;
    loadingMore.value = true;
    try {
      const page = await balance.listBalanceEntries(id, before);
      if (current !== generation) return;
      batch(() => {
        entries.value = [...entries.value, ...page.entries];
        nextBefore.value = page.nextBefore;
      });
    } catch (failure) {
      if (current !== generation) return;
      error.value = errorText(failure);
    } finally {
      if (current === generation) loadingMore.value = false;
    }
  }

  // Тело — по схеме TopupRequest; пустой комментарий уходит как null. Успех перечитывает баланс той же организации.
  async function topup(
    input: { amountUsd: string; comment: string },
    requireComment: boolean,
  ): Promise<boolean> {
    if (submitting.value) return false;
    const id = orgId.value;
    formError.value = null;
    commentError.value = null;
    if (id === null) return false;
    const comment = input.comment.trim();
    if (requireComment && comment === '') {
      commentError.value = FORM_TEXT.comment;
      return false;
    }
    const body = TopupRequest.safeParse({
      amountMicroUsd: usdToMicro(input.amountUsd),
      comment: comment === '' ? null : comment,
    });
    if (!body.success) {
      formError.value = TOPUP_INVALID_TEXT;
      return false;
    }
    const current = generation;
    submitting.value = true;
    try {
      await balance.topup(id, body.data);
    } catch (failure) {
      if (current === generation) formError.value = errorText(failure);
      return false;
    } finally {
      if (current === generation) submitting.value = false;
    }
    if (current === generation) await open(id);
    return true;
  }

  return {
    orgId,
    view,
    entries,
    nextBefore,
    loaded,
    loadingMore,
    submitting,
    error,
    formError,
    commentError,
    canTopup,
    open,
    more,
    topup,
  };
}
