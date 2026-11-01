import { ChangeDetectionStrategy, Component, DestroyRef, inject, Input } from '@angular/core';
import { RouterLink } from '@angular/router';
import type { PlatformEvent } from '@swag/contracts';
import { failureReasonText, formatAgentStep, formatLlmCall, formatUsd } from '@swag/ui-core';
import { AlertComponent, ButtonDirective, CABINET_STORE, PageComponent } from '@swag/ui-angular';
import { SwarmGraphComponent } from './swarm-graph.ts';

const STATUS_LABEL: Record<string, string> = {
  starting: 'запускается',
  running: 'работает',
  completed: 'завершён',
  stopped: 'остановлен',
  failed: 'ошибка',
};

// Спека 014, REQ-014-17/18 и 4.12: страница роя. `id` приходит входом маршрута (`withComponentInputBinding`):
// сеттер открывает рой при каждом заходе и при смене id, подписок и effect нет. Поток закрывается на `DestroyRef`.
@Component({
  selector: 'app-swarm-page',
  imports: [AlertComponent, ButtonDirective, PageComponent, RouterLink, SwarmGraphComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @let state = cabinet.swarm();
    @let feed = state?.feed ?? [];
    <swag-page [title]="state?.view?.task ?? 'Рой'">
      <p><a routerLink="/">← Все рои</a></p>
      @if (state?.view; as swarm) {
        @if (cabinet.stoppable()) {
          <button swag-button type="button" (click)="stop()" [busy]="cabinet.stopping()">
            Стоп
          </button>
        }
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
          <swag-alert kind="error">
            <h2>Ошибка</h2>
            <p>
              {{ failureReasonText(failure.reason) }}
              @if (failure.detail) {
                : {{ failure.detail }}
              }
            </p>
          </swag-alert>
        }
      } @else {
        <p>{{ state?.connected ? 'Загрузка…' : 'Подключение к рою…' }}</p>
      }

      @if (cabinet.swarmError(); as message) {
        <swag-alert kind="error">{{ message }}</swag-alert>
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
    </swag-page>
  `,
})
export class SwarmPageComponent {
  protected readonly cabinet = inject(CABINET_STORE);
  private readonly destroyRef = inject(DestroyRef);

  readonly formatUsd = formatUsd;
  readonly failureReasonText = failureReasonText;

  @Input() set id(id: string) {
    this.cabinet.openSwarm(id);
  }

  constructor() {
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
