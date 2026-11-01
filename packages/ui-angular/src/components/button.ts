import { booleanAttribute, computed, Directive, input } from '@angular/core';

export type ButtonVariant = 'primary' | 'secondary' | 'danger';

// Спека 014, 4.8: `swag-button`. Селектор — атрибут на нативной кнопке, чтобы `type` остался нативным
// (submit внутри форм, как в login.page.ts) и не появлялся лишний вход. Стили вариантов — в styles/base.css.
@Directive({
  selector: 'button[swag-button]',
  host: {
    class: 'swag-button',
    '[class.swag-button--primary]': "variant() === 'primary'",
    '[class.swag-button--secondary]': "variant() === 'secondary'",
    '[class.swag-button--danger]': "variant() === 'danger'",
    '[disabled]': 'blocked()',
    '[attr.aria-busy]': "busy() ? 'true' : null",
  },
})
export class ButtonDirective {
  readonly variant = input<ButtonVariant>('primary');
  readonly disabled = input(false, { transform: booleanAttribute });
  readonly busy = input(false, { transform: booleanAttribute });
  // busy блокирует повторное нажатие: нативный disabled.
  protected readonly blocked = computed(() => this.disabled() || this.busy());
}
