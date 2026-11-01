import { Component, computed, input } from '@angular/core';

export type AlertKind = 'error' | 'info' | 'success';

// Спека 014, 4.8: `swag-alert`. У ошибки `role="alert"`, у остальных — `role="status"`.
@Component({
  selector: 'swag-alert',
  host: {
    '[attr.data-kind]': 'kind()',
    '[attr.role]': 'role()',
  },
  template: `<ng-content />`,
  styles: `
    :host {
      display: block;
      margin: var(--swag-space-3) 0;
      padding: var(--swag-space-3) var(--swag-space-4);
      border-radius: var(--swag-radius-md);
      border: 1px solid var(--swag-color-border);
      background: var(--swag-color-surface-2);
      color: var(--swag-color-text);
    }
    :host([data-kind='error']) {
      background: var(--swag-color-danger);
      border-color: var(--swag-color-danger);
      color: var(--swag-color-danger-text);
    }
    :host([data-kind='success']) {
      border-left: 4px solid var(--swag-color-success);
    }
  `,
})
export class AlertComponent {
  readonly kind = input<AlertKind>('info');
  protected readonly role = computed(() => (this.kind() === 'error' ? 'alert' : 'status'));
}
