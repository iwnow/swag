import { Component, input } from '@angular/core';

// Спека 014, 4.8: `swag-page` — заголовок страницы и область содержимого.
@Component({
  selector: 'swag-page',
  template: `
    <section class="swag-page">
      <h1>{{ title() }}</h1>
      <ng-content />
    </section>
  `,
})
export class PageComponent {
  readonly title = input.required<string>();
}
