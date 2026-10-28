import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import type { SwarmView } from '@swag/api-integration';

// Граф роя по спеке 022, 4.10: агенты по кругу в порядке id (первый — сверху), цвет по статусу,
// на каждом ребре from → to стрелка и число сообщений. Встречные рёбра (a → b и b → a) — две дуги
// в разные стороны, петли — дуга наружу от круга. Чистый SVG, геометрия — в чистых функциях ниже.
const NODE_W = 150;
const NODE_H = 80;
const MIN_RADIUS = 120;
const NODE_GAP = 60; // минимальный зазор между соседними узлами по хорде
const PAD = 90; // больше LOOP: петля крайнего узла остаётся в границах SVG
const BEND = 0.3; // смещение средней точки дуги встречного ребра, доля длины ребра
const LOOP = 60; // высота петли над узлом

export interface Point {
  x: number;
  y: number;
}

export interface GraphLayout {
  centers: Point[]; // центры узлов в порядке view.agents
  origin: Point; // центр круга
  width: number;
  height: number;
}

export function layoutNodes(count: number): GraphLayout {
  const radius =
    count < 2
      ? MIN_RADIUS
      : Math.max(MIN_RADIUS, (NODE_W + NODE_GAP) / (2 * Math.sin(Math.PI / count)));
  const origin = { x: PAD + radius + NODE_W / 2, y: PAD + radius + NODE_H / 2 };
  const centers = Array.from({ length: count }, (_, i) => {
    const angle = -Math.PI / 2 + (2 * Math.PI * i) / count;
    return {
      x: origin.x + radius * Math.cos(angle),
      y: origin.y + radius * Math.sin(angle),
    };
  });
  return { centers, origin, width: origin.x * 2, height: origin.y * 2 };
}

// Точка границы узла, в которую попадает луч из его центра к точке target.
function rectExit(center: Point, target: Point): Point {
  const dx = target.x - center.x;
  const dy = target.y - center.y;
  const t = Math.min(
    dx === 0 ? Infinity : NODE_W / 2 / Math.abs(dx),
    dy === 0 ? Infinity : NODE_H / 2 / Math.abs(dy),
  );
  return { x: center.x + dx * t, y: center.y + dy * t };
}

export interface EdgePath {
  d: string;
  label: Point;
}

// Путь ребра from → to (индексы в layout.centers). reciprocal — есть встречное ребро:
// тогда дуга изгибается, и пара рисуется двумя дугами по разные стороны от прямой.
export function edgePath(
  layout: GraphLayout,
  from: number,
  to: number,
  reciprocal: boolean,
): EdgePath {
  const a = layout.centers[from];
  const b = layout.centers[to];
  if (from === to) return loopPath(layout, a);

  const bend = reciprocal ? BEND : 0;
  const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  // Контрольная точка — сдвиг середины по левой нормали к направлению from → to.
  const control = { x: mid.x - dy * bend, y: mid.y + dx * bend };
  const start = rectExit(a, control);
  const end = rectExit(b, control);
  return {
    d: quad(start, control, end),
    label: quadPoint(start, control, end),
  };
}

function loopPath(layout: GraphLayout, center: Point): EdgePath {
  const dx = center.x - layout.origin.x;
  const dy = center.y - layout.origin.y;
  const len = Math.hypot(dx, dy);
  const u = len === 0 ? { x: 0, y: -1 } : { x: dx / len, y: dy / len }; // наружу от круга
  const t = { x: -u.y, y: u.x };
  const base = rectExit(center, { x: center.x + u.x, y: center.y + u.y });
  const start = { x: base.x - t.x * 16, y: base.y - t.y * 16 };
  const end = { x: base.x + t.x * 16, y: base.y + t.y * 16 };
  const control = { x: base.x + u.x * LOOP * 2, y: base.y + u.y * LOOP * 2 };
  const peak = quadPoint(start, control, end);
  return { d: quad(start, control, end), label: { x: peak.x + u.x * 12, y: peak.y + u.y * 12 } };
}

function quad(start: Point, control: Point, end: Point): string {
  return `M ${start.x} ${start.y} Q ${control.x} ${control.y} ${end.x} ${end.y}`;
}

// Точка квадратичной кривой при t = 0.5.
function quadPoint(start: Point, control: Point, end: Point): Point {
  return {
    x: 0.25 * start.x + 0.5 * control.x + 0.25 * end.x,
    y: 0.25 * start.y + 0.5 * control.y + 0.25 * end.y,
  };
}

@Component({
  selector: 'app-swarm-graph',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <svg
      [attr.width]="layout().width"
      [attr.height]="layout().height"
      role="img"
      aria-label="Граф роя"
    >
      <defs>
        <marker
          id="arrow"
          viewBox="0 0 10 10"
          refX="10"
          refY="5"
          markerWidth="8"
          markerHeight="8"
          orient="auto-start-reverse"
        >
          <path d="M 0 0 L 10 5 L 0 10 z" fill="#5b6472" />
        </marker>
      </defs>
      @for (edge of edges(); track edge.key) {
        <path
          [attr.d]="edge.d"
          fill="none"
          stroke="#5b6472"
          stroke-width="2"
          marker-end="url(#arrow)"
        />
        <text
          [attr.x]="edge.label.x"
          [attr.y]="edge.label.y"
          text-anchor="middle"
          class="edge-label"
        >
          {{ edge.messages }} сообщ.
        </text>
      }
      @for (node of nodes(); track node.id) {
        <g
          [attr.transform]="'translate(' + node.x + ',' + node.y + ')'"
          [attr.data-status]="node.status"
        >
          <rect
            width="150"
            height="80"
            rx="10"
            [attr.fill]="node.fill"
            stroke="#2b3240"
            stroke-width="1.5"
          />
          <text x="75" y="24" text-anchor="middle" class="node-name">{{ node.name }}</text>
          <text x="75" y="44" text-anchor="middle" class="node-status">
            {{ node.id }} · {{ node.statusText }}
          </text>
          <text x="75" y="64" text-anchor="middle" class="node-status">
            {{ node.model }} · шагов: {{ node.steps }}
          </text>
        </g>
      }
    </svg>
  `,
  styles: `
    .node-name {
      font:
        600 14px system-ui,
        sans-serif;
      fill: #111827;
    }
    .node-status {
      font:
        12px system-ui,
        sans-serif;
      fill: #374151;
    }
    .edge-label {
      font:
        12px system-ui,
        sans-serif;
      fill: #374151;
      paint-order: stroke;
      stroke: #fff;
      stroke-width: 4px;
    }
  `,
})
export class SwarmGraphComponent {
  readonly view = input.required<SwarmView>();

  protected readonly layout = computed(() => layoutNodes(this.view().agents.length));

  protected readonly nodes = computed(() => {
    const { centers } = this.layout();
    return this.view().agents.map((agent, i) => ({
      id: agent.id,
      name: agent.name,
      model: agent.model,
      steps: agent.steps,
      status: agent.status,
      statusText: STATUS_TEXT[agent.status],
      fill: STATUS_FILL[agent.status],
      x: centers[i].x - NODE_W / 2,
      y: centers[i].y - NODE_H / 2,
    }));
  });

  protected readonly edges = computed(() => {
    const view = this.view();
    const layout = this.layout();
    const index = new Map(view.agents.map((agent, i) => [agent.id, i]));
    const pairs = new Set(view.edges.map((edge) => `${edge.from}>${edge.to}`));
    return view.edges.flatMap((edge) => {
      const from = index.get(edge.from);
      const to = index.get(edge.to);
      if (from === undefined || to === undefined) return [];
      const reciprocal = pairs.has(`${edge.to}>${edge.from}`);
      return [
        {
          key: `${edge.from}>${edge.to}`,
          messages: edge.messages,
          ...edgePath(layout, from, to, reciprocal),
        },
      ];
    });
  });
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
