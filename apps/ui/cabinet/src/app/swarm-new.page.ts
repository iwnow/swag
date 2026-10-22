import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import type { FormIssue } from '@swag/ui-core';
import { UI, errorText } from './ui.ts';

interface AgentField {
  name: string;
  role: string;
}

@Component({
  selector: 'app-swarm-new-page',
  imports: [RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <h1>Новый рой</h1>
    <form (submit)="$event.preventDefault(); submit()">
      <label>
        Задача
        <textarea rows="3" [value]="task()" (input)="setTask($event)"></textarea>
      </label>

      <h2>Агенты</h2>
      <p class="hint">
        Порядок сверху вниз — порядок цепочки: каждый агент передаёт результат следующему.
      </p>
      @for (agent of agents(); track $index; let i = $index) {
        <div class="agent-row">
          <span class="index">{{ i + 1 }}</span>
          <input placeholder="Имя" [value]="agent.name" (input)="setAgent(i, 'name', $event)" />
          <input
            placeholder="Роль: что делает агент"
            [value]="agent.role"
            (input)="setAgent(i, 'role', $event)"
          />
          <button type="button" (click)="removeAgent(i)" [disabled]="agents().length === 1">
            Удалить
          </button>
        </div>
      }
      <button type="button" (click)="addAgent()" [disabled]="agents().length >= 8">
        Добавить агента
      </button>

      @if (issues().length > 0) {
        <ul class="error">
          @for (issue of issues(); track $index) {
            <li>{{ issue.path || 'форма' }}: {{ issue.message }}</li>
          }
        </ul>
      }
      @if (serverError(); as message) {
        <p class="error">{{ message }}</p>
      }

      <div class="actions">
        <a routerLink="/">Отмена</a>
        <button type="submit" [disabled]="submitting()">Запустить</button>
      </div>
    </form>
  `,
})
export class SwarmNewPageComponent {
  private readonly ui = inject(UI);
  private readonly router = inject(Router);

  readonly task = signal('');
  readonly agents = signal<AgentField[]>([{ name: '', role: '' }]);
  readonly issues = signal<FormIssue[]>([]);
  readonly serverError = signal<string | null>(null);
  readonly submitting = signal(false);

  setTask(event: Event): void {
    this.task.set((event.target as HTMLTextAreaElement).value);
  }

  setAgent(index: number, field: keyof AgentField, event: Event): void {
    const value = (event.target as HTMLInputElement).value;
    this.agents.update((list) =>
      list.map((agent, i) => (i === index ? { ...agent, [field]: value } : agent)),
    );
  }

  addAgent(): void {
    this.agents.update((list) => [...list, { name: '', role: '' }]);
  }

  removeAgent(index: number): void {
    this.agents.update((list) => list.filter((_, i) => i !== index));
  }

  async submit(): Promise<void> {
    this.serverError.set(null);
    const form = { task: this.task(), agents: this.agents() };
    const check = this.ui.validateForm(form);
    if (!check.ok) {
      this.issues.set(check.issues);
      return;
    }
    this.issues.set([]);
    this.submitting.set(true);
    try {
      const result = await this.ui.createSwarm(form);
      if (result.ok && result.view) {
        await this.router.navigate(['/swarms', result.view.id]);
      }
    } catch (error) {
      this.serverError.set(errorText(error));
    } finally {
      this.submitting.set(false);
    }
  }
}
