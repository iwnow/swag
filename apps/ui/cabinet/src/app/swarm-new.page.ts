import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { PlatformModel } from '@swag/contracts';
import type { AgentInput } from '@swag/ui-core';
import { CABINET_STORE } from '@swag/ui-angular';

const DEFAULT_MODEL: PlatformModel = 'chat-small';
// Спека 004, Q-5: бюджет роя по умолчанию — $0.50.
const DEFAULT_BUDGET_USD = '0.50';

const newAgent = (): AgentInput => ({
  name: '',
  role: '',
  model: DEFAULT_MODEL,
  budget: '',
  maxTokens: '',
});

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
      <label>
        Бюджет, $
        <input type="number" min="0" step="0.01" [value]="budget()" (input)="setBudget($event)" />
      </label>
      <label>
        Лимит ответа, токенов
        <input
          type="number"
          min="1"
          step="1"
          placeholder="по умолчанию"
          aria-label="Лимит ответа, токенов"
          [value]="maxTokens()"
          (input)="setMaxTokens($event)"
        />
      </label>

      <h2>Агенты</h2>
      <p class="hint">
        Первый агент получает задачу от пользователя и завершает рой через finish; остальные
        отвечают ему через send_message.
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
          <input
            type="number"
            min="0"
            step="0.01"
            placeholder="Бюджет агента, $"
            aria-label="Бюджет агента, $"
            [value]="agent.budget"
            (input)="setAgent(i, 'budget', $event)"
          />
          <input
            type="number"
            min="1"
            step="1"
            placeholder="Лимит ответа, токенов"
            aria-label="Лимит ответа, токенов"
            [value]="agent.maxTokens"
            (input)="setAgent(i, 'maxTokens', $event)"
          />
          <select (change)="setModel(i, $event)" aria-label="Модель">
            @for (model of models; track model) {
              <option [value]="model" [selected]="model === agent.model">{{ model }}</option>
            }
          </select>
          <button type="button" (click)="removeAgent(i)" [disabled]="agents().length === 1">
            Удалить
          </button>
        </div>
      }
      <button type="button" (click)="addAgent()" [disabled]="agents().length >= 8">
        Добавить агента
      </button>

      @if (cabinet.form().issues.length > 0) {
        <ul class="error">
          @for (issue of cabinet.form().issues; track $index) {
            <li>{{ issue.path || 'форма' }}: {{ issue.message }}</li>
          }
        </ul>
      }
      @if (cabinet.form().error; as message) {
        <p class="error">{{ message }}</p>
      }

      <div class="actions">
        <a routerLink="/">Отмена</a>
        <button type="submit" [disabled]="cabinet.form().busy">Запустить</button>
      </div>
    </form>
  `,
})
export class SwarmNewPageComponent {
  protected readonly cabinet = inject(CABINET_STORE);
  private readonly router = inject(Router);

  readonly models = PlatformModel.options;
  readonly task = signal('');
  readonly budget = signal(DEFAULT_BUDGET_USD);
  readonly maxTokens = signal('');
  readonly agents = signal<AgentInput[]>([newAgent()]);

  setTask(event: Event): void {
    this.task.set((event.target as HTMLTextAreaElement).value);
  }

  setBudget(event: Event): void {
    this.budget.set((event.target as HTMLInputElement).value);
  }

  setMaxTokens(event: Event): void {
    this.maxTokens.set((event.target as HTMLInputElement).value);
  }

  setAgent(index: number, field: keyof AgentInput, event: Event): void {
    const value = (event.target as HTMLInputElement).value;
    this.agents.update((list) =>
      list.map((agent, i) => (i === index ? { ...agent, [field]: value } : agent)),
    );
  }

  setModel(index: number, event: Event): void {
    const model = (event.target as HTMLSelectElement).value as PlatformModel;
    this.agents.update((list) =>
      list.map((agent, i) => (i === index ? { ...agent, model } : agent)),
    );
  }

  addAgent(): void {
    this.agents.update((list) => [...list, newAgent()]);
  }

  removeAgent(index: number): void {
    this.agents.update((list) => list.filter((_, i) => i !== index));
  }

  async submit(): Promise<void> {
    const id = await this.cabinet.createSwarm({
      task: this.task(),
      budget: this.budget(),
      maxTokens: this.maxTokens(),
      agents: this.agents(),
    });
    if (id !== null) await this.router.navigate(['/swarms', id]);
  }
}
