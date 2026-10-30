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
import {
  formatAgentStep,
  formatLlmCall,
  formatSwarmMoney,
  formatUsd,
  spentLastMinute,
  unreadMessageIds,
} from '@swag/ui-core';
import { failureReasonText } from './money.ts';
import { SwarmGraphComponent } from './swarm-graph.ts';
import { UI, errorText } from './ui.ts';

const STATUS_LABEL: Record<string, string> = {
  starting: 'запускается',
  running: 'работает',
  completed: 'завершён',
  stopped: 'остановлен',
  failed: 'ошибка',
};

// Спека 004, 4.8: строка денег и «за минуту» обновляются раз в 5 с.
const MONEY_TICK_MS = 5000;

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
      <p class="money">{{ money() }}</p>
      <app-swarm-graph [view]="swarm" />

      <section>
        <h2>Агенты</h2>
        <ul>
          @for (agent of swarm.agents; track agent.id) {
            <li>
              {{ agent.name }} ({{ agent.model }}): потрачено {{ formatUsd(agent.spentMicroUsd) }}
              @if (agent.budgetMicroUsd; as budget) {
                из {{ formatUsd(budget) }}
              }
            </li>
          }
        </ul>
      </section>

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
            {{ failureReasonText(failure.reason) }}
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
              @if (unread().has(event.id)) {
                <span class="unread"> · не прочитано</span>
              }
              @if (traceUrl(event); as url) {
                <a class="trace" [href]="url" target="_blank" rel="noopener">Трейс</a>
              }
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
  readonly unread = computed(() => {
    const status = this.view()?.status;
    return status === undefined ? new Set<string>() : unreadMessageIds(this.feed(), status);
  });
  readonly now = signal(Date.now());
  readonly money = computed(() => {
    const swarm = this.view();
    return swarm === null
      ? null
      : formatSwarmMoney(swarm, spentLastMinute(this.feed(), this.now()));
  });
  readonly formatUsd = formatUsd;
  readonly failureReasonText = failureReasonText;

  private readonly page = this.ui.openSwarm(this.id);
  private readonly unsubscribe = this.page.onChange(() => {
    this.view.set(this.page.view);
    this.feed.set([...this.page.feed]);
    this.connected.set(this.page.connected);
    this.now.set(Date.now());
  });
  private readonly moneyTimer = setInterval(() => this.now.set(Date.now()), MONEY_TICK_MS);

  traceUrl(event: PlatformEvent): string | null {
    return this.ui.traceUrl(event.traceId);
  }

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
        return failureReasonText(event.data.reason);
      case 'agent.step':
        return formatAgentStep(event.data);
      case 'llm.call':
        return formatLlmCall(event.data);
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
    clearInterval(this.moneyTimer);
    this.unsubscribe();
    this.page.close();
  }
}
