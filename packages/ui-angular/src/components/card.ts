import { Component, input } from '@angular/core';

// Спека 014, 4.8: `swag-card` — блок с заголовком.
@Component({
  selector: 'swag-card',
  template: `
    <section class="swag-card">
      <h2 class="swag-card__title">{{ title() }}</h2>
      <ng-content />
    </section>
  `,
  styles: `
    .swag-card {
      background: var(--swag-color-surface);
      border: 1px solid var(--swag-color-surface-2);
      border-radius: var(--swag-radius-md);
      box-shadow: var(--swag-shadow-1);
      padding: var(--swag-space-4);
      margin: var(--swag-space-4) 0;
    }
    .swag-card__title {
      margin: 0 0 var(--swag-space-3);
    }
  `,
})
export class CardComponent {
  readonly title = input.required<string>();
}
