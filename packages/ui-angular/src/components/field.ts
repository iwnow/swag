import { afterEveryRender, Component, ElementRef, inject, input } from '@angular/core';

let nextFieldId = 0;

// Спека 014, 4.8: `swag-field`. Директива не нужна: после каждого рендера компонент находит проецируемый
// контрол (input, select, textarea) и ставит ему `aria-describedby` и `aria-invalid` на id ошибки.
@Component({
  selector: 'swag-field',
  template: `
    <label class="swag-field__label">
      <span>{{ label() }}</span>
      <ng-content />
    </label>
    @if (error(); as message) {
      <p class="swag-field__error" [id]="errorId">{{ message }}</p>
    }
  `,
  styles: `
    :host {
      display: block;
      margin: var(--swag-space-3) 0;
    }
    .swag-field__label {
      display: block;
    }
    .swag-field__error {
      margin: var(--swag-space-1) 0 0;
      color: var(--swag-color-danger);
      font-size: var(--swag-text-sm);
    }
  `,
})
export class FieldComponent {
  readonly label = input.required<string>();
  readonly error = input<string | null>(null);
  protected readonly errorId = `swag-field-error-${nextFieldId++}`;
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);

  constructor() {
    afterEveryRender(() => this.linkControl());
  }

  private linkControl(): void {
    const control = this.host.nativeElement.querySelector('input, select, textarea');
    if (control === null) return;
    if (this.error() === null) {
      control.removeAttribute('aria-describedby');
      control.removeAttribute('aria-invalid');
    } else {
      control.setAttribute('aria-describedby', this.errorId);
      control.setAttribute('aria-invalid', 'true');
    }
  }
}
