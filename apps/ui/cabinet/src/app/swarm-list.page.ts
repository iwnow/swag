import { ChangeDetectionStrategy, Component, OnInit, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import type { SwarmSummary } from '@swag/contracts';
import { UI, errorText } from './ui.ts';

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
    @if (error(); as message) {
      <p class="error">{{ message }}</p>
    }
    @if (swarms().length === 0 && loaded()) {
      <p>Роёв пока нет.</p>
    }
    @if (swarms().length > 0) {
      <table>
        <thead>
          <tr><th>Задача</th><th>Статус</th><th>Агентов</th><th>Создан</th></tr>
        </thead>
        <tbody>
          @for (swarm of swarms(); track swarm.id) {
            <tr>
              <td><a [routerLink]="['/swarms', swarm.id]">{{ swarm.task }}</a></td>
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
export class SwarmListPageComponent implements OnInit {
  private readonly ui = inject(UI);
  readonly swarms = signal<SwarmSummary[]>([]);
  readonly loaded = signal(false);
  readonly error = signal<string | null>(null);

  statusLabel(status: string): string {
    return STATUS_LABEL[status] ?? status;
  }

  async ngOnInit(): Promise<void> {
    try {
      this.swarms.set(await this.ui.listSwarms());
    } catch (error) {
      this.error.set(errorText(error));
    } finally {
      this.loaded.set(true);
    }
  }
}
