import {
  booleanAttribute,
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  input,
  signal,
  untracked,
} from '@angular/core';
import { RouterLink } from '@angular/router';
import {
  ROLE_PERMISSIONS,
  TopupRequest,
  type BalanceEntry,
  type BalanceView,
} from '@swag/contracts';
import { FORM_TEXT, formatUsd, usdToMicro } from '@swag/ui-core';
import { createBalanceApi } from './balance-api.ts';
import { AlertComponent } from './components/alert.ts';
import { ButtonDirective } from './components/button.ts';
import { FieldComponent } from './components/field.ts';
import { TableComponent } from './components/table.ts';
import { CurrentUser, SESSION } from './session.ts';

const KIND_LABEL: Record<BalanceEntry['kind'], string> = { topup: 'Пополнение', swarm: 'Рой' };

const signedUsd = (micro: number): string =>
  micro < 0 ? `−${formatUsd(-micro)}` : `${micro > 0 ? '+' : ''}${formatUsd(micro)}`;

const formatDate = (ts: string): string =>
  new Date(ts).toLocaleString('ru-RU', {
    timeZone: 'Europe/Moscow',
    dateStyle: 'short',
    timeStyle: 'short',
  });

const errorText = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

// Спека 013, 4.11 и 014, 4.7: панель баланса организации. Числа и история — от API, правил нет.
// Форма пополнения — при праве `balance.topup` у роли из /auth/me. `requireComment` делает комментарий обязательным (014, 4.6).
@Component({
  selector: 'swag-balance-panel',
  imports: [RouterLink, ButtonDirective, AlertComponent, FieldComponent, TableComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (orgId() === null) {
      <p>Баланс доступен только пользователям организации.</p>
    } @else {
      @if (error(); as message) {
        <swag-alert kind="error">{{ message }}</swag-alert>
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

      @if (canTopup()) {
        <h2>Пополнение</h2>
        <form (submit)="$event.preventDefault(); topup()">
          <swag-field label="Сумма, $">
            <input
              type="number"
              min="0"
              step="0.000001"
              [value]="amount()"
              (input)="setAmount($event)"
            />
          </swag-field>
          <swag-field label="Комментарий" [error]="commentError()">
            <input maxlength="500" [value]="comment()" (input)="setComment($event)" />
          </swag-field>
          @if (formError(); as message) {
            <swag-alert kind="error">{{ message }}</swag-alert>
          }
          <button swag-button type="submit" [busy]="submitting()">Пополнить</button>
        </form>
      }

      <h2>История</h2>
      <swag-table [empty]="loaded() ? 'Записей пока нет.' : ''">
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
      </swag-table>
      @if (nextBefore() !== null) {
        <button
          swag-button
          variant="secondary"
          type="button"
          [busy]="loading()"
          (click)="loadMore()"
        >
          Ещё
        </button>
      }
    }
  `,
  styles: `
    .numbers {
      display: flex;
      flex-wrap: wrap;
      gap: var(--swag-space-5);
      margin: var(--swag-space-4) 0;
    }
    .numbers span {
      display: block;
      color: var(--swag-color-text-muted);
      font-size: var(--swag-text-sm);
    }
    .numbers strong {
      font-size: var(--swag-text-lg);
    }
  `,
})
export class BalancePanelComponent {
  readonly orgId = input<string | null>(null);
  readonly requireComment = input(false, { transform: booleanAttribute });
  private readonly api = createBalanceApi(inject(SESSION));
  private readonly current = inject(CurrentUser);

  readonly balance = signal<BalanceView | null>(null);
  readonly entries = signal<BalanceEntry[]>([]);
  readonly nextBefore = signal<number | null>(null);
  readonly loaded = signal(false);
  readonly loading = signal(false);
  readonly error = signal<string | null>(null);

  readonly canTopup = computed(() => {
    const role = this.current.role();
    return role !== null && ROLE_PERMISSIONS[role].includes('balance.topup');
  });
  readonly amount = signal('');
  readonly comment = signal('');
  readonly formError = signal<string | null>(null);
  readonly commentError = signal<string | null>(null);
  readonly submitting = signal(false);

  readonly usd = formatUsd;
  readonly signed = signedUsd;
  readonly date = formatDate;
  readonly kind = (value: BalanceEntry['kind']): string => KIND_LABEL[value];

  constructor() {
    // Смена orgId (переключение организации) сбрасывает состояние и перечитывает данные. Остальное читается untracked.
    effect(() => {
      const orgId = this.orgId();
      untracked(() => {
        this.balance.set(null);
        this.entries.set([]);
        this.nextBefore.set(null);
        this.error.set(null);
        this.loaded.set(false);
        this.formError.set(null);
        this.commentError.set(null);
        void this.reload(orgId);
      });
    });
  }

  async loadMore(): Promise<void> {
    const orgId = this.orgId();
    const before = this.nextBefore();
    if (orgId === null || before === null) return;
    this.loading.set(true);
    try {
      const page = await this.api.listBalanceEntries(orgId, before);
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

  // Тело — по схеме TopupRequest; пустой комментарий уходит как null. Без комментария при requireComment — ошибка поля.
  async topup(): Promise<void> {
    const orgId = this.orgId();
    if (orgId === null) return;
    this.formError.set(null);
    this.commentError.set(null);
    const comment = this.comment().trim();
    if (this.requireComment() && comment === '') {
      this.commentError.set(FORM_TEXT.comment);
      return;
    }
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
      await this.api.topup(orgId, body.data);
      this.amount.set('');
      this.comment.set('');
      await this.reload(orgId);
    } catch (error) {
      this.formError.set(errorText(error));
    } finally {
      this.submitting.set(false);
    }
  }

  // Баланс и первая страница истории перечитываются вместе.
  // Ответ, пришедший после смены orgId, не применяется.
  private async reload(orgId: string | null): Promise<void> {
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
      if (this.orgId() !== orgId) return;
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
