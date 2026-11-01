import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { PlatformModel } from '@swag/contracts';
import type { AgentInput } from '@swag/ui-core';
import {
  AlertComponent,
  ButtonDirective,
  CABINET_STORE,
  FieldComponent,
  PageComponent,
} from '@swag/ui-angular';

const DEFAULT_MODEL: PlatformModel = 'chat-small';
// Спека 004, Q-5: бюджет роя по умолчанию — $0.50.
const DEFAULT_BUDGET_USD = '0.50';

// Пути ошибок `SwarmCreateRequest` (ui-core, `validateForm`): поля роя и поля агентов по индексу.
const SWARM_FIELDS = ['task', 'budgetMicroUsd', 'maxTokens'];
const AGENT_FIELDS = ['name', 'role', 'model', 'budgetMicroUsd', 'maxTokens'];

const newAgent = (): AgentInput => ({
  name: '',
  role: '',
  model: DEFAULT_MODEL,
  budget: '',
  maxTokens: '',
});

// Спека 014, 4.8 и REQ-014-17: поля на `swag-field`, ошибка — по `path` из `cabinet.form()`.
// Ошибки, которые не привязаны к полю, выводятся общим `swag-alert`.
@Component({
  selector: 'app-swarm-new-page',
  imports: [AlertComponent, ButtonDirective, FieldComponent, PageComponent, RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <swag-page title="Новый рой">
      <form (submit)="$event.preventDefault(); submit()">
        <swag-field label="Задача" [error]="fieldError('task')">
          <textarea rows="3" [value]="task()" (input)="setTask($event)"></textarea>
        </swag-field>
        <swag-field label="Бюджет, $" [error]="fieldError('budgetMicroUsd')">
          <input type="number" min="0" step="0.01" [value]="budget()" (input)="setBudget($event)" />
        </swag-field>
        <swag-field label="Лимит ответа, токенов" [error]="fieldError('maxTokens')">
          <input
            type="number"
            min="1"
            step="1"
            placeholder="по умолчанию"
            [value]="maxTokens()"
            (input)="setMaxTokens($event)"
          />
        </swag-field>

        <h2>Агенты</h2>
        <p class="hint">
          Первый агент получает задачу от пользователя и завершает рой через finish; остальные
          отвечают ему через send_message.
        </p>
        @for (agent of agents(); track $index; let i = $index) {
          <div class="agent-row">
            <span class="index">{{ i + 1 }}</span>
            <swag-field label="Имя" [error]="agentError(i, 'name')">
              <input placeholder="Имя" [value]="agent.name" (input)="setAgent(i, 'name', $event)" />
            </swag-field>
            <swag-field label="Роль" [error]="agentError(i, 'role')">
              <input
                placeholder="Роль: что делает агент"
                [value]="agent.role"
                (input)="setAgent(i, 'role', $event)"
              />
            </swag-field>
            <swag-field label="Бюджет агента, $" [error]="agentError(i, 'budgetMicroUsd')">
              <input
                type="number"
                min="0"
                step="0.01"
                placeholder="Бюджет агента, $"
                [value]="agent.budget"
                (input)="setAgent(i, 'budget', $event)"
              />
            </swag-field>
            <swag-field label="Лимит ответа, токенов" [error]="agentError(i, 'maxTokens')">
              <input
                type="number"
                min="1"
                step="1"
                placeholder="Лимит ответа, токенов"
                [value]="agent.maxTokens"
                (input)="setAgent(i, 'maxTokens', $event)"
              />
            </swag-field>
            <swag-field label="Модель" [error]="agentError(i, 'model')">
              <select (change)="setModel(i, $event)">
                @for (model of models; track model) {
                  <option [value]="model" [selected]="model === agent.model">{{ model }}</option>
                }
              </select>
            </swag-field>
            <button
              swag-button
              variant="secondary"
              type="button"
              (click)="removeAgent(i)"
              [disabled]="agents().length === 1"
            >
              Удалить
            </button>
          </div>
        }
        <button
          swag-button
          variant="secondary"
          type="button"
          (click)="addAgent()"
          [disabled]="agents().length >= 8"
        >
          Добавить агента
        </button>

        @for (issue of unmatchedIssues(); track $index) {
          <swag-alert kind="error">{{ issue.path || 'форма' }}: {{ issue.message }}</swag-alert>
        }
        @if (cabinet.form().error; as message) {
          <swag-alert kind="error">{{ message }}</swag-alert>
        }

        <div class="actions">
          <a routerLink="/">Отмена</a>
          <button swag-button type="submit" [busy]="cabinet.form().busy">Запустить</button>
        </div>
      </form>
    </swag-page>
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

  constructor() {
    this.cabinet.resetForm();
  }

  fieldError(path: string): string | null {
    return this.cabinet.form().issues.find((issue) => issue.path === path)?.message ?? null;
  }

  agentError(index: number, field: string): string | null {
    return this.fieldError(`agents.${index}.${field}`);
  }

  unmatchedIssues() {
    return this.cabinet.form().issues.filter((issue) => !this.isFieldPath(issue.path));
  }

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

  private isFieldPath(path: string): boolean {
    const parts = path.split('.');
    if (parts.length === 1) return SWARM_FIELDS.includes(path);
    const [head, index, field] = parts;
    return (
      parts.length === 3 &&
      head === 'agents' &&
      Number(index) < this.agents().length &&
      AGENT_FIELDS.includes(field)
    );
  }
}
