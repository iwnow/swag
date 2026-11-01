import { Component, input } from '@angular/core';

// Спека 014, 4.8: `swag-table`. Вход только `empty`. Пустота определяется CSS `:has(tbody tr)` в styles/base.css:
// без строк прячутся таблица и заголовки, показывается текст `empty`; со строками текст скрыт.
@Component({
  selector: 'swag-table',
  template: `
    <div class="swag-table">
      <ng-content />
      <p class="swag-table__empty">{{ empty() }}</p>
    </div>
  `,
})
export class TableComponent {
  readonly empty = input('');
}
