import {
  type AfterViewInit,
  Component,
  inject,
  input,
  type OnDestroy,
  output,
  TemplateRef,
  viewChild,
} from '@angular/core';
import { Dialog, DialogRef } from '@angular/cdk/dialog';
import { ButtonDirective } from './button.ts';

// Спека 014, 4.8: `swag-confirm` на `@angular/cdk/dialog`. Компонент открывает диалог при появлении
// и закрывает при уничтожении. Esc и закрытие диалога без выбора — `cancelled`.
@Component({
  selector: 'swag-confirm',
  imports: [ButtonDirective],
  template: `
    <ng-template #content>
      <div class="swag-confirm">
        <p class="swag-confirm__text">{{ text() }}</p>
        <div class="swag-confirm__actions">
          <button swag-button variant="secondary" type="button" (click)="cancel()">Отмена</button>
          <button swag-button variant="danger" type="button" (click)="confirm()">
            Подтвердить
          </button>
        </div>
      </div>
    </ng-template>
  `,
  styles: `
    .swag-confirm {
      background: var(--swag-color-surface);
      color: var(--swag-color-text);
      border-radius: var(--swag-radius-md);
      box-shadow: var(--swag-shadow-1);
      padding: var(--swag-space-4);
      max-width: 28rem;
    }
    .swag-confirm__actions {
      display: flex;
      justify-content: flex-end;
      gap: var(--swag-space-2);
      margin-top: var(--swag-space-4);
    }
  `,
})
export class ConfirmComponent implements AfterViewInit, OnDestroy {
  readonly text = input.required<string>();
  readonly confirmed = output<void>();
  readonly cancelled = output<void>();
  private readonly dialog = inject(Dialog);
  private readonly content = viewChild.required<TemplateRef<unknown>>('content');
  private ref: DialogRef<unknown> | null = null;
  private finished = false;

  ngAfterViewInit(): void {
    this.ref = this.dialog.open(this.content(), { panelClass: 'swag-confirm-panel' });
    this.ref.closed.subscribe(() => {
      if (this.finished) return;
      this.finished = true;
      this.cancelled.emit();
    });
  }

  confirm(): void {
    this.finished = true;
    this.confirmed.emit();
    this.ref?.close();
  }

  cancel(): void {
    this.finished = true;
    this.cancelled.emit();
    this.ref?.close();
  }

  ngOnDestroy(): void {
    this.finished = true;
    this.ref?.close();
  }
}
