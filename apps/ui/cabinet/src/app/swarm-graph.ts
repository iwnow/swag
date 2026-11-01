import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import type { SwarmView } from '@swag/api-integration';

// Граф роя по спеке 022, 4.10: агенты по кругу в порядке id (первый — сверху), цвет по статусу,
// на каждом ребре from → to стрелка и число сообщений. Встречные рёбра (a → b и b → a) — две дуги
// внутрь круга на разную глубину (наружу дуга задела бы соседние узлы), петли — дуга наружу от круга. Чистый SVG, геометрия — в чистых функциях ниже.
const NODE_W = 150;
const NODE_H = 80;
const MIN_RADIUS = 120;
const NODE_GAP = 60; // минимальный зазор между соседними узлами по хорде
const PAD = 90; // больше LOOP: петля крайнего узла остаётся в границах SVG
const BENDS = [15, 60]; // глубина дуг встречной пары, px: ребро от меньшего индекса — первая
const PAIR_LABEL_T = 0.4; // подпись дуги пары ближе к её началу: подписи пары не накладываются
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
// тогда пара рисуется двумя дугами внутрь круга на разную глубину.
export function edgePath(
  layout: GraphLayout,
  from: number,
  to: number,
  reciprocal: boolean,
): EdgePath {
  const a = layout.centers[from];
  const b = layout.centers[to];
  if (from === to) return loopPath(layout, a);

  const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  const control = reciprocal ? bendControl(layout, mid, from, to) : mid;
  const start = rectExit(a, control);
  const end = rectExit(b, control);
  return {
    d: quad(start, control, end),
    label: quadPoint(start, control, end, reciprocal ? PAIR_LABEL_T : 0.5),
  };
}

// Контрольная точка дуги встречного ребра: нормаль к паре (одна на оба направления), к центру круга.
// Вершина квадратичной кривой — на половине смещения контрольной точки.
function bendControl(layout: GraphLayout, mid: Point, from: number, to: number): Point {
  const p = layout.centers[Math.min(from, to)];
  const q = layout.centers[Math.max(from, to)];
  const len = Math.hypot(q.x - p.x, q.y - p.y);
  let n = { x: -(q.y - p.y) / len, y: (q.x - p.x) / len };
  if (n.x * (layout.origin.x - mid.x) + n.y * (layout.origin.y - mid.y) < 0)
    n = { x: -n.x, y: -n.y };
  const depth = BENDS[from < to ? 0 : 1] * 2;
  return { x: mid.x + n.x * depth, y: mid.y + n.y * depth };
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

// Точка квадратичной кривой при параметре t.
function quadPoint(start: Point, control: Point, end: Point, t = 0.5): Point {
  const s = 1 - t;
  return {
    x: s * s * start.x + 2 * s * t * control.x + t * t * end.x,
    y: s * s * start.y + 2 * s * t * control.y + t * t * end.y,
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
          <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--swag-color-text-muted)" />
        </marker>
      </defs>
      @for (edge of edges(); track edge.key) {
        <path
          [attr.d]="edge.d"
          fill="none"
          stroke="var(--swag-color-text-muted)"
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
            [attr.width]="nodeW"
            [attr.height]="nodeH"
            rx="10"
            [attr.fill]="node.fill"
            stroke="var(--swag-color-text)"
            stroke-width="1.5"
          />
          <text [attr.x]="nodeW / 2" y="24" text-anchor="middle" class="node-name">
            {{ node.name }}
          </text>
          <text [attr.x]="nodeW / 2" y="44" text-anchor="middle" class="node-status">
            {{ node.id }} · {{ node.statusText }}
          </text>
          <text [attr.x]="nodeW / 2" y="64" text-anchor="middle" class="node-status">
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
      fill: var(--swag-color-text);
    }
    .node-status {
      font:
        12px system-ui,
        sans-serif;
      fill: var(--swag-color-text-muted);
    }
    .edge-label {
      font:
        12px system-ui,
        sans-serif;
      fill: var(--swag-color-text-muted);
      paint-order: stroke;
      stroke: var(--swag-color-surface);
      stroke-width: 4px;
    }
  `,
})
export class SwarmGraphComponent {
  readonly view = input.required<SwarmView>();
  protected readonly nodeW = NODE_W;
  protected readonly nodeH = NODE_H;

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
  starting: 'var(--swag-color-surface-2)',
  idle: 'color-mix(in srgb, var(--swag-color-primary) 20%, var(--swag-color-surface))',
  working: 'color-mix(in srgb, var(--swag-color-warning) 35%, var(--swag-color-surface))',
  done: 'color-mix(in srgb, var(--swag-color-success) 30%, var(--swag-color-surface))',
  stopped: 'var(--swag-color-bg)',
  failed: 'color-mix(in srgb, var(--swag-color-danger) 25%, var(--swag-color-surface))',
};
