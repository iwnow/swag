import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { RouterLink } from '@angular/router';
import { AlertComponent, PageComponent, SUPERVISOR_STORE, TableComponent } from '@swag/ui-angular';
import { formatDateTime } from '@swag/ui-core';

// Спека 014, REQ-014-13: страница «Организации» супервизора. Логика — в `SupervisorStore`, страница только рисует.

@Component({
  selector: 'app-organizations-page',
  imports: [AlertComponent, PageComponent, RouterLink, TableComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <swag-page title="Организации">
      @if (store.error(); as message) {
        <swag-alert kind="error">{{ message }}</swag-alert>
      }
      <swag-table [empty]="store.loaded() ? 'Организаций пока нет.' : ''">
        <table>
          <thead>
            <tr>
              <th>Название</th>
              <th>Пользователей</th>
              <th>Создана</th>
            </tr>
          </thead>
          <tbody>
            @for (org of store.organizations(); track org.id) {
              <tr>
                <td>
                  <a [routerLink]="['/supervisor', 'organizations', org.id]">{{ org.name }}</a>
                </td>
                <td>{{ org.userCount }}</td>
                <td>{{ formatDate(org.createdAt) }}</td>
              </tr>
            }
          </tbody>
        </table>
      </swag-table>
    </swag-page>
  `,
})
export class OrganizationsPageComponent {
  protected readonly store = inject(SUPERVISOR_STORE);
  protected readonly formatDate = formatDateTime;

  constructor() {
    void this.store.loadOrganizations();
  }
}
