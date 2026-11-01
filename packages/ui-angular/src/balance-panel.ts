import {
  ChangeDetectionStrategy,
  Component,
  effect,
  input,
  output,
  signal,
  untracked,
} from '@angular/core';
import { RouterLink } from '@angular/router';
import type { BalanceEntry } from '@swag/contracts';
import { formatUsd, type BalanceState } from '@swag/ui-core';
import { AlertComponent } from './components/alert.ts';
import { ButtonDirective } from './components/button.ts';
import { FieldComponent } from './components/field.ts';
import { TableComponent } from './components/table.ts';
import type { Connected } from './stores.ts';

const KIND_LABEL: Record<BalanceEntry['kind'], string> = { topup: 'Пополнение', swarm: 'Рой' };

const signedUsd = (micro: number): string =>
  micro < 0 ? `−${formatUsd(-micro)}` : `${micro > 0 ? '+' : ''}${formatUsd(micro)}`;

const formatDate = (ts: string): string =>
  new Date(ts).toLocaleString('ru-RU', {
    timeZone: 'Europe/Moscow',
    dateStyle: 'short',
    timeStyle: 'short',
  });

// Спека 013, 4.11 и 014, 4.12: панель баланса без своего состояния. Данные, проверки и запросы — в сторе
// (`state`, BalanceState из ui-core). Панель рисует сигналы и отдаёт ввод формы наружу через `topup` и `more`.
@Component({
  selector: 'swag-balance-panel',
  imports: [RouterLink, ButtonDirective, AlertComponent, FieldComponent, TableComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (state().orgId() === null) {
      <p>Баланс доступен только пользователям организации.</p>
    } @else {
      @if (state().error(); as message) {
        <swag-alert kind="error">{{ message }}</swag-alert>
      }
      @if (state().view(); as view) {
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

      @if (state().canTopup()) {
        <h2>Пополнение</h2>
        <form (submit)="$event.preventDefault(); submit()">
          <swag-field label="Сумма, $">
            <input
              type="number"
              min="0"
              step="0.000001"
              [value]="amount()"
              (input)="setAmount($event)"
            />
          </swag-field>
          <swag-field label="Комментарий" [error]="state().commentError()">
            <input maxlength="500" [value]="comment()" (input)="setComment($event)" />
          </swag-field>
          @if (state().formError(); as message) {
            <swag-alert kind="error">{{ message }}</swag-alert>
          }
          <button swag-button type="submit" [busy]="state().submitting()">Пополнить</button>
        </form>
      }

      <h2>История</h2>
      <swag-table [empty]="state().loaded() ? 'Записей пока нет.' : ''">
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
            @for (entry of state().entries(); track entry.id) {
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
      @if (state().nextBefore() !== null) {
        <button
          swag-button
          variant="secondary"
          type="button"
          [busy]="state().loadingMore()"
          (click)="more.emit()"
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
  readonly state = input.required<Connected<BalanceState>>();
  readonly more = output<void>();
  readonly topup = output<{ amountUsd: string; comment: string }>();

  readonly amount = signal('');
  readonly comment = signal('');

  readonly usd = formatUsd;
  readonly signed = signedUsd;
  readonly date = formatDate;
  readonly kind = (value: BalanceEntry['kind']): string => KIND_LABEL[value];

  constructor() {
    // Поля формы очищаются, когда отправка прошла без ошибки формы: проверки и запросы — в сторе.
    let sending = false;
    effect(() => {
      const busy = this.state().submitting();
      untracked(() => {
        if (busy) {
          sending = true;
          return;
        }
        if (sending && this.state().formError() === null) {
          this.amount.set('');
          this.comment.set('');
        }
        sending = false;
      });
    });
  }

  setAmount(event: Event): void {
    this.amount.set((event.target as HTMLInputElement).value);
  }

  setComment(event: Event): void {
    this.comment.set((event.target as HTMLInputElement).value);
  }

  submit(): void {
    this.topup.emit({ amountUsd: this.amount(), comment: this.comment() });
  }
}
