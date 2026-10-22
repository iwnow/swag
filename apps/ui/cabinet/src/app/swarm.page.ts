import {
  ChangeDetectionStrategy,
  Component,
  OnDestroy,
  computed,
  inject,
  signal,
} from '@angular/core';
import { ActivatedRoute, RouterLink } from '@angular/router';
import type { PlatformEvent } from '@swag/contracts';
import type { SwarmView } from '@swag/api-integration';
import { SwarmGraphComponent } from './swarm-graph.ts';
import { UI, errorText } from './ui.ts';

const STATUS_LABEL: Record<string, string> = {
  starting: 'запускается',
  running: 'работает',
  completed: 'завершён',
  stopped: 'остановлен',
  failed: 'ошибка',
};

@Component({
  selector: 'app-swarm-page',
  imports: [RouterLink, SwarmGraphComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <p><a routerLink="/">← Все рои</a></p>
    @if (view(); as swarm) {
      <div class="toolbar">
        <h1>{{ swarm.task }}</h1>
        @if (stoppable()) {
          <button type="button" (click)="stop()" [disabled]="stopping()">Стоп</button>
        }
      </div>
      <p>
        Статус: <strong>{{ statusLabel(swarm.status) }}</strong> ·
        {{ connected() ? 'поток подключён' : 'переподключение…' }}
      </p>
      <app-swarm-graph [view]="swarm" />

      @if (swarm.status === 'completed') {
        <section>
          <h2>Результат</h2>
          <pre>{{ swarm.result }}</pre>
        </section>
      }
      @if (swarm.status === 'failed' && swarm.failure; as failure) {
        <section class="error">
          <h2>Ошибка</h2>
          <p>
            {{ failure.reason }}
            @if (failure.detail) {
              : {{ failure.detail }}
            }
          </p>
        </section>
      }
    } @else {
      <p>{{ connected() ? 'Загрузка…' : 'Подключение к рою…' }}</p>
    }

    @if (error(); as message) {
      <p class="error">{{ message }}</p>
    }

    @if (feed().length > 0) {
      <section>
        <h2>Лента</h2>
        <ol class="feed">
          @for (event of feed(); track event.seq) {
            <li>
              <span class="seq">#{{ event.seq }}</span>
              <span class="type">{{ event.type }}</span>
              @if (event.agentId) {
                <span class="agent">{{ event.agentId }}</span>
              }
              <span class="detail">{{ detail(event) }}</span>
            </li>
          }
        </ol>
      </section>
    }
  `,
})
export class SwarmPageComponent implements OnDestroy {
  private readonly ui = inject(UI);
  private readonly route = inject(ActivatedRoute);
  readonly id = this.route.snapshot.paramMap.get('id') ?? '';

  readonly view = signal<SwarmView | null>(null);
  readonly feed = signal<PlatformEvent[]>([]);
  readonly connected = signal(false);
  readonly stopping = signal(false);
  readonly error = signal<string | null>(null);
  readonly stoppable = computed(() => {
    const status = this.view()?.status;
    return status === 'starting' || status === 'running';
  });

  private readonly page = this.ui.openSwarm(this.id);
  private readonly unsubscribe = this.page.onChange(() => {
    this.view.set(this.page.view);
    this.feed.set([...this.page.feed]);
    this.connected.set(this.page.connected);
  });

  statusLabel(status: string): string {
    return STATUS_LABEL[status] ?? status;
  }

  detail(event: PlatformEvent): string {
    switch (event.type) {
      case 'bus.message':
        return `${event.data.from} → ${event.data.to}: ${event.data.text}`;
      case 'swarm.completed':
        return event.data.result;
      case 'swarm.failed':
        return event.data.reason;
      default:
        return '';
    }
  }

  async stop(): Promise<void> {
    this.stopping.set(true);
    try {
      await this.page.stop();
    } catch (error) {
      this.error.set(errorText(error));
    } finally {
      this.stopping.set(false);
    }
  }

  ngOnDestroy(): void {
    this.unsubscribe();
    this.page.close();
  }
}
