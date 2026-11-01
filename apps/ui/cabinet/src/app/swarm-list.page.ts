import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { RouterLink } from '@angular/router';
import { AlertComponent, CABINET_STORE, PageComponent, TableComponent } from '@swag/ui-angular';

const STATUS_LABEL: Record<string, string> = {
  starting: 'запускается',
  running: 'работает',
  completed: 'завершён',
  stopped: 'остановлен',
  failed: 'ошибка',
};

// Спека 014, 4.8 и REQ-014-17: список на `swag-page` и `swag-table`. Текст «пусто» — только после загрузки.
@Component({
  selector: 'app-swarm-list-page',
  imports: [AlertComponent, PageComponent, RouterLink, TableComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <swag-page title="Рои">
      <p><a class="button" routerLink="/swarms/new">Новый рой</a></p>
      @if (cabinet.swarmsError(); as message) {
        <swag-alert kind="error">{{ message }}</swag-alert>
      }
      <swag-table [empty]="cabinet.swarmsLoaded() ? 'Роёв пока нет.' : ''">
        <table>
          <thead>
            <tr>
              <th>Задача</th>
              <th>Статус</th>
              <th>Агентов</th>
              <th>Создан</th>
            </tr>
          </thead>
          <tbody>
            @for (swarm of cabinet.swarms(); track swarm.id) {
              <tr>
                <td>
                  <a [routerLink]="['/swarms', swarm.id]">{{ swarm.task }}</a>
                </td>
                <td>{{ statusLabel(swarm.status) }}</td>
                <td>{{ swarm.agentCount }}</td>
                <td>{{ swarm.createdAt }}</td>
              </tr>
            }
          </tbody>
        </table>
      </swag-table>
    </swag-page>
  `,
})
export class SwarmListPageComponent {
  protected readonly cabinet = inject(CABINET_STORE);

  constructor() {
    void this.cabinet.loadSwarms();
  }

  statusLabel(status: string): string {
    return STATUS_LABEL[status] ?? status;
  }
}
