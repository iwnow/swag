import { ChangeDetectionStrategy, Component, OnInit, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import {
  ROLE_PERMISSIONS,
  TopupRequest,
  type BalanceEntry,
  type BalanceView,
} from '@swag/contracts';
import { formatUsd, usdToMicro } from '@swag/ui-core';
import { SESSION, currentUser } from './session.ts';
import { BALANCE, errorText } from './ui.ts';

const KIND_LABEL: Record<BalanceEntry['kind'], string> = { topup: 'Пополнение', swarm: 'Рой' };

const signedUsd = (micro: number): string =>
  micro < 0 ? `−${formatUsd(-micro)}` : `${micro > 0 ? '+' : ''}${formatUsd(micro)}`;

const formatDate = (ts: string): string =>
  new Date(ts).toLocaleString('ru-RU', {
    timeZone: 'Europe/Moscow',
    dateStyle: 'short',
    timeStyle: 'short',
  });

// Спека 013, 4.11: страница «Баланс» — три числа и история. Правил нет: суммы и страницы приходят от API.
@Component({
  selector: 'app-balance-page',
  imports: [RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <h1>Баланс</h1>
    @if (orgId === null) {
      <p>Баланс доступен только пользователям организации.</p>
    } @else {
      @if (error(); as message) {
        <p class="error">{{ message }}</p>
      }
      @if (balance(); as view) {
        <div class="numbers">
          <div>
            <span>Баланс</span>
            <strong>{{ usd(view.balanceMicroUsd) }}</strong>
          </div>
          <div>
            <span>В резерве</span>
            <strong>{{ usd(view.heldMicroUsd) }}</strong>
          </div>
          <div>
            <span>Доступно</span>
            <strong>{{ usd(view.availableMicroUsd) }}</strong>
          </div>
        </div>
      }

      @if (canTopup) {
        <h2>Пополнение</h2>
        <form (submit)="$event.preventDefault(); topup()">
          <label>
            Сумма, $
            <input
              type="number"
              min="0"
              step="0.000001"
              [value]="amount()"
              (input)="setAmount($event)"
            />
          </label>
          <label>
            Комментарий
            <input maxlength="500" [value]="comment()" (input)="setComment($event)" />
          </label>
          @if (formError(); as message) {
            <p class="error">{{ message }}</p>
          }
          <button type="submit" [disabled]="submitting()">Пополнить</button>
        </form>
      }

      <h2>История</h2>
      @if (entries().length === 0 && loaded()) {
        <p>Записей пока нет.</p>
      }
      @if (entries().length > 0) {
        <table>
          <thead>
            <tr>
              <th>Дата</th>
              <th>Вид</th>
              <th>Сумма</th>
              <th>Рой</th>
              <th>Комментарий</th>
            </tr>
          </thead>
          <tbody>
            @for (entry of entries(); track entry.id) {
              <tr>
                <td>{{ date(entry.ts) }}</td>
                <td>{{ kind(entry.kind) }}</td>
                <td>{{ signed(entry.amountMicroUsd) }}</td>
                <td>
                  @if (entry.swarmId; as swarmId) {
                    <a [routerLink]="['/swarms', swarmId]">Открыть рой</a>
                  }
                </td>
                <td>{{ entry.comment ?? '' }}</td>
              </tr>
            }
          </tbody>
        </table>
      }
      @if (nextBefore() !== null) {
        <button type="button" class="secondary" [disabled]="loading()" (click)="loadMore()">
          Ещё
        </button>
      }
    }
  `,
})
export class BalancePageComponent implements OnInit {
  private readonly api = inject(BALANCE);
  private readonly user = currentUser(inject(SESSION));
  readonly orgId = this.user?.orgId ?? null;

  readonly balance = signal<BalanceView | null>(null);
  readonly entries = signal<BalanceEntry[]>([]);
  readonly nextBefore = signal<number | null>(null);
  readonly loaded = signal(false);
  readonly loading = signal(false);
  readonly error = signal<string | null>(null);

  // Спека 013, 4.11: форма пополнения — только при праве `balance.topup` у роли сессии.
  readonly canTopup =
    this.user !== null && ROLE_PERMISSIONS[this.user.role].includes('balance.topup');
  readonly amount = signal('');
  readonly comment = signal('');
  readonly formError = signal<string | null>(null);
  readonly submitting = signal(false);

  readonly usd = formatUsd;
  readonly signed = signedUsd;
  readonly date = formatDate;
  readonly kind = (value: BalanceEntry['kind']): string => KIND_LABEL[value];

  async ngOnInit(): Promise<void> {
    await this.reload();
  }

  async loadMore(): Promise<void> {
    const before = this.nextBefore();
    if (this.orgId === null || before === null) return;
    this.loading.set(true);
    try {
      const page = await this.api.listBalanceEntries(this.orgId, before);
      this.entries.update((list) => [...list, ...page.entries]);
      this.nextBefore.set(page.nextBefore);
    } catch (error) {
      this.error.set(errorText(error));
    } finally {
      this.loading.set(false);
    }
  }

  setAmount(event: Event): void {
    this.amount.set((event.target as HTMLInputElement).value);
  }

  setComment(event: Event): void {
    this.comment.set((event.target as HTMLInputElement).value);
  }

  // Тело — по схеме TopupRequest; пустой комментарий уходит как null. После успеха перечитываются баланс и история с первой страницы.
  async topup(): Promise<void> {
    if (this.orgId === null) return;
    this.formError.set(null);
    const comment = this.comment().trim();
    const body = TopupRequest.safeParse({
      amountMicroUsd: usdToMicro(this.amount()),
      comment: comment === '' ? null : comment,
    });
    if (!body.success) {
      this.formError.set('Проверьте сумму: от $0.000001 до $1000, комментарий до 500 символов.');
      return;
    }
    this.submitting.set(true);
    try {
      await this.api.topup(this.orgId, body.data);
      this.amount.set('');
      this.comment.set('');
      await this.reload();
    } catch (error) {
      this.formError.set(errorText(error));
    } finally {
      this.submitting.set(false);
    }
  }

  // Баланс и первая страница истории перечитываются вместе.
  private async reload(): Promise<void> {
    const orgId = this.orgId;
    if (orgId === null) {
      this.loaded.set(true);
      return;
    }
    this.error.set(null);
    try {
      const [balance, page] = await Promise.all([
        this.api.getBalance(orgId),
        this.api.listBalanceEntries(orgId, null),
      ]);
      this.balance.set(balance);
      this.entries.set(page.entries);
      this.nextBefore.set(page.nextBefore);
    } catch (error) {
      this.error.set(errorText(error));
    } finally {
      this.loaded.set(true);
    }
  }
}
