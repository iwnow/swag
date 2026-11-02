import {
  NodeManifest,
  type EgressHost,
  type NodeCredential,
  type NodeErrorCode,
  type NodeTypeName,
  type NodeTypeVersion,
  type OperationAccess,
} from '@swag/contracts';
import { z } from 'zod';

// Спека 021, 4.3. Настройки узла — объектная схема Zod.
type Settings = z.ZodObject;
type Ctx<S extends Settings> = NodeContext<z.output<S>>;

// Всё, что видит код узла. Реализацию на платформе даёт 026; поля 026 может только добавлять.
export interface NodeContext<S> {
  settings: S;
  secrets: { get(name: string): Promise<string> };
  http: { fetch(url: string, init?: RequestInit): Promise<Response> };
  log: {
    debug(msg: string, data?: object): void;
    info(msg: string, data?: object): void;
    warn(msg: string, data?: object): void;
    error(msg: string, data?: object): void;
  };
  state: {
    get(key: string): Promise<string | null>;
    set(key: string, value: string | null): Promise<void>;
  }; // null — удалить ключ
  signal: AbortSignal;
}

// D-160 (а): коды ошибок узла берутся из контракта, SDK их не дублирует.
export type { NodeErrorCode };

export class NodeError extends Error {
  readonly code: NodeErrorCode;

  constructor(code: NodeErrorCode, message: string) {
    super(message);
    this.code = code;
    this.name = 'NodeError';
  }
}

export interface PollResult<E> {
  events: E[];
  cursor: string | null;
}

interface Base<S extends Settings> {
  type: NodeTypeName;
  version: NodeTypeVersion;
  title: string;
  description: string;
  settings: S;
  credentials?: NodeCredential[]; // по умолчанию []
  egress?: EgressHost[]; // по умолчанию []
}

export interface TriggerDefinition<S extends Settings, E> extends Base<S> {
  kind: 'trigger';
  outputs: z.ZodType<E>;
  poll(cursor: string | null, ctx: Ctx<S>): Promise<PollResult<E>>;
}

export interface ChannelDefinition<S extends Settings, In, Out> extends Base<S> {
  kind: 'channel';
  inputs: z.ZodType<Out>; // исходящее сообщение
  outputs: z.ZodType<In>; // входящее сообщение
  poll(cursor: string | null, ctx: Ctx<S>): Promise<PollResult<In>>;
  send(message: Out, ctx: Ctx<S>): Promise<void>;
}

export interface OperationDefinition<S extends Settings, I, O> {
  title: string;
  description: string;
  access: OperationAccess;
  input: z.ZodType<I>;
  output: z.ZodType<O>;
  execute(input: I, ctx: Ctx<S>): Promise<O>;
}

export interface ConnectorDefinition<S extends Settings> extends Base<S> {
  kind: 'connector';
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- операции разных типов в одном Record, 021 4.3
  operations: Record<string, OperationDefinition<S, any, any>>; // ключ — NodeOperation.name; порядок в манифесте — порядок ключей
}

export interface ProgramDefinition<S extends Settings, I, O> extends Base<S> {
  kind: 'program';
  inputs: z.ZodType<I>;
  outputs: z.ZodType<O>;
  execute(input: I, ctx: Ctx<S>): Promise<O>;
}

export interface BuiltinDefinition<S extends Settings> extends Base<S> {
  kind: 'llm-agent' | 'human'; // кода нет, исполняет платформа
}

// any здесь — союз видов хранит определения с разными типами схем (021, 4.3).
/* eslint-disable @typescript-eslint/no-explicit-any */
export type NodeDefinition =
  | TriggerDefinition<any, any>
  | ChannelDefinition<any, any, any>
  | ConnectorDefinition<any>
  | ProgramDefinition<any, any, any>
  | BuiltinDefinition<any>;
/* eslint-enable @typescript-eslint/no-explicit-any */

export type SettingsOf<D extends NodeDefinition> = z.output<D['settings']>;

// Перегрузка на вид: обработчики получают типы из схем. Без проверок во время выполнения.
export function defineNode<S extends Settings, E>(
  d: TriggerDefinition<S, E>,
): TriggerDefinition<S, E>;
export function defineNode<S extends Settings, In, Out>(
  d: ChannelDefinition<S, In, Out>,
): ChannelDefinition<S, In, Out>;
export function defineNode<S extends Settings>(d: ConnectorDefinition<S>): ConnectorDefinition<S>;
export function defineNode<S extends Settings, I, O>(
  d: ProgramDefinition<S, I, O>,
): ProgramDefinition<S, I, O>;
export function defineNode<S extends Settings>(d: BuiltinDefinition<S>): BuiltinDefinition<S>;
export function defineNode(definition: NodeDefinition): NodeDefinition {
  return definition;
}

function jsonSchema(schema: z.ZodType, io: 'input' | 'output'): Record<string, unknown> {
  return z.toJSONSchema(schema, { io }) as Record<string, unknown>;
}

// Спека 021, 4.3, REQ-021-8: правила выгрузки; результат проверяется NodeManifest.parse.
export function toManifest(definition: NodeDefinition): NodeManifest {
  const d = definition;
  const operations =
    'operations' in d
      ? Object.entries(d.operations).map(([name, op]) => ({
          name,
          title: op.title,
          description: op.description,
          access: op.access,
          input: jsonSchema(op.input, 'input'),
          output: jsonSchema(op.output, 'output'),
        }))
      : [];
  return NodeManifest.parse({
    type: d.type,
    version: d.version,
    kind: d.kind,
    title: d.title,
    description: d.description,
    settings: jsonSchema(d.settings, 'input'),
    credentials: d.credentials ?? [],
    egress: d.egress ?? [],
    inputs: 'inputs' in d ? jsonSchema(d.inputs, 'input') : null,
    outputs: 'outputs' in d ? jsonSchema(d.outputs, 'output') : null,
    operations,
  });
}
