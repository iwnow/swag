import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  effect,
  inject,
  input,
  untracked,
} from '@angular/core';
import { RouterLink } from '@angular/router';
import type { PlatformEvent } from '@swag/contracts';
import { failureReasonText, formatAgentStep, formatLlmCall, formatUsd } from '@swag/ui-core';
import { CABINET_STORE } from '@swag/ui-angular';
import { SwarmGraphComponent } from './swarm-graph.ts';

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
    @let state = cabinet.swarm();
    @let feed = state?.feed ?? [];
    <p><a routerLink="/">← Все рои</a></p>
    @if (state?.view; as swarm) {
      <div class="toolbar">
        <h1>{{ swarm.task }}</h1>
        @if (cabinet.stoppable()) {
          <button type="button" (click)="stop()" [disabled]="cabinet.stopping()">Стоп</button>
        }
      </div>
      <p>
        Статус: <strong>{{ statusLabel(swarm.status) }}</strong> ·
        {{ state?.connected ? 'поток подключён' : 'переподключение…' }}
      </p>
      <p class="money">{{ cabinet.money() }}</p>
      <app-swarm-graph [view]="swarm" />

      <section>
        <h2>Агенты</h2>
        <ul>
          @for (agent of swarm.agents; track agent.id) {
            <li>
              {{ agent.name }} ({{ agent.model }}): потрачено {{ formatUsd(agent.spentMicroUsd) }}
              @if (agent.budgetMicroUsd != null) {
                из {{ formatUsd(agent.budgetMicroUsd) }}
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
      <p>{{ state?.connected ? 'Загрузка…' : 'Подключение к рою…' }}</p>
    }

    @if (cabinet.swarmError(); as message) {
      <p class="error">{{ message }}</p>
    }

    @if (feed.length > 0) {
      <section>
        <h2>Лента</h2>
        <ol class="feed">
          @for (event of feed; track event.seq) {
            <li>
              <span class="seq">#{{ event.seq }}</span>
              <span class="type">{{ event.type }}</span>
              @if (event.agentId) {
                <span class="agent">{{ event.agentId }}</span>
              }
              <span class="detail">{{ detail(event) }}</span>
              @if (cabinet.unread().has(event.id)) {
                <span class="unread"> · не прочитано</span>
              }
              @if (cabinet.traceUrl(event.traceId); as url) {
                <a class="trace" [href]="url" target="_blank" rel="noopener">Трейс</a>
              }
            </li>
          }
        </ol>
      </section>
    }
  `,
})
export class SwarmPageComponent {
  protected readonly cabinet = inject(CABINET_STORE);
  private readonly destroyRef = inject(DestroyRef);

  readonly id = input.required<string>();
  readonly formatUsd = formatUsd;
  readonly failureReasonText = failureReasonText;

  constructor() {
    effect(() => {
      const id = this.id();
      untracked(() => this.cabinet.openSwarm(id));
    });
    this.destroyRef.onDestroy(() => this.cabinet.closeSwarm());
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

  stop(): void {
    void this.cabinet.stopSwarm();
  }
}
