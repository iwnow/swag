import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import type { SwarmView } from '@swag/api-integration';

// Граф роя: цепочка агентов слева направо, цвет по статусу, на рёбрах — число сообщений. Чистый SVG.
const NODE_W = 150;
const NODE_H = 64;
const GAP = 70;
const PAD = 20;

@Component({
  selector: 'app-swarm-graph',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <svg [attr.width]="width()" [attr.height]="height" role="img" aria-label="Граф роя">
      <defs>
        <marker id="arrow" viewBox="0 0 10 10" refX="10" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse">
          <path d="M 0 0 L 10 5 L 0 10 z" fill="#5b6472" />
        </marker>
      </defs>
      @for (edge of edges(); track $index) {
        <line
          [attr.x1]="edge.x1"
          [attr.y1]="edge.y"
          [attr.x2]="edge.x2"
          [attr.y2]="edge.y"
          stroke="#5b6472"
          stroke-width="2"
          marker-end="url(#arrow)"
        />
        <text [attr.x]="edge.labelX" [attr.y]="edge.y - 8" text-anchor="middle" class="edge-label">
          {{ edge.messages }} сообщ.
        </text>
      }
      @for (node of nodes(); track node.id) {
        <g [attr.transform]="'translate(' + node.x + ',' + node.y + ')'" [attr.data-status]="node.status">
          <rect width="150" height="64" rx="10" [attr.fill]="node.fill" stroke="#2b3240" stroke-width="1.5" />
          <text x="75" y="26" text-anchor="middle" class="node-name">{{ node.name }}</text>
          <text x="75" y="46" text-anchor="middle" class="node-status">{{ node.id }} · {{ node.statusText }}</text>
        </g>
      }
    </svg>
  `,
  styles: `
    .node-name { font: 600 14px system-ui, sans-serif; fill: #111827; }
    .node-status { font: 12px system-ui, sans-serif; fill: #374151; }
    .edge-label { font: 12px system-ui, sans-serif; fill: #374151; }
  `,
})
export class SwarmGraphComponent {
  readonly view = input.required<SwarmView>();

  private readonly layout = computed(() => {
    const view = this.view();
    return view.agents.map((agent, i) => ({
      id: agent.id,
      name: agent.name,
      status: agent.status,
      statusText: STATUS_TEXT[agent.status],
      fill: STATUS_FILL[agent.status],
      x: PAD + i * (NODE_W + GAP),
      y: PAD,
    }));
  });

  protected readonly nodes = computed(() => this.layout());

  protected readonly edges = computed(() => {
    const view = this.view();
    const positions = new Map(this.layout().map((n) => [n.id, n.x]));
    return view.edges.flatMap((edge) => {
      const fromX = positions.get(edge.from);
      const toX = positions.get(edge.to);
      if (fromX === undefined || toX === undefined) return [];
      const x1 = fromX + NODE_W;
      const x2 = toX;
      return [
        {
          x1,
          x2,
          y: PAD + NODE_H / 2,
          labelX: (x1 + x2) / 2,
          messages: edge.messages,
        },
      ];
    });
  });

  protected readonly width = computed(() => PAD * 2 + this.view().agents.length * NODE_W + Math.max(0, this.view().agents.length - 1) * GAP);
  protected readonly height = PAD * 2 + NODE_H;
}

const STATUS_TEXT: Record<string, string> = {
  starting: 'запускается',
  idle: 'ждёт',
  working: 'работает',
  done: 'готов',
  stopped: 'остановлен',
  failed: 'ошибка',
};

const STATUS_FILL: Record<string, string> = {
  starting: '#e5e7eb',
  idle: '#dbeafe',
  working: '#fde68a',
  done: '#bbf7d0',
  stopped: '#f3f4f6',
  failed: '#fecaca',
};
