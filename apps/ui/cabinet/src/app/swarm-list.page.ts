import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { RouterLink } from '@angular/router';
import { CABINET_STORE } from '@swag/ui-angular';

const STATUS_LABEL: Record<string, string> = {
  starting: 'запускается',
  running: 'работает',
  completed: 'завершён',
  stopped: 'остановлен',
  failed: 'ошибка',
};

@Component({
  selector: 'app-swarm-list-page',
  imports: [RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="toolbar">
      <h1>Рои</h1>
      <a class="button" routerLink="/swarms/new">Новый рой</a>
    </div>
    @if (cabinet.swarmsError(); as message) {
      <p class="error">{{ message }}</p>
    }
    @if (cabinet.swarms().length === 0 && cabinet.swarmsLoaded()) {
      <p>Роёв пока нет.</p>
    }
    @if (cabinet.swarms().length > 0) {
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
    }
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
