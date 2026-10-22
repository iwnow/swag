import { describe, expect, it } from 'vitest';
import { connectNatsBus } from '@swag/adapter-nats';
import { createMemoryExporters, startTelemetry, type Telemetry } from '@swag/adapter-telemetry';
import { LogRecord } from '@swag/contracts';
import { startAgentProcess } from '../src/start.ts';

// AC-016-11: механизм — вызов функции старта с внедрёнными зависимостями (а не дочерний процесс):
// настоящие adapter-telemetry и adapter-nats, экспорт логов в память, exit — фейк.
const TRACE = '4bf92f3577b34da6a3ce929d0e0e4736';
const SWARM = '0b6f6d2e-6a4c-4c3e-9f5e-111111111111';

const env = {
  NATS_URL: 'nats://127.0.0.1:1', // никто не слушает
  SWARM_ID: SWARM,
  AGENT_ID: 'agent-2',
  AGENT_NAME: 'Редактор',
  AGENT_ROLE: 'Проверяет текст',
  AGENT_NEXT: '',
  AGENT_STEP_DELAY_MS: '0',
  TRACEPARENT: `00-${TRACE}-00f067aa0ba902b7-01`,
  OTEL_EXPORTER_OTLP_ENDPOINT: 'http://otel-collector:4318',
  TELEMETRY_FLUSH_TIMEOUT_MS: '500',
};

describe('старт агента', () => {
  it('AC-016-11: NATS недоступен — последняя запись error с traceId T, swarmId, agentId и err; сброс телеметрии до выхода с кодом 1', async () => {
    const memory = createMemoryExporters();
    const lines: string[] = [];
    const order: string[] = [];
    let exitCode: number | null = null;

    const agent = await startAgentProcess({
      env,
      version: 'test',
      startTelemetry: (options) => {
        expect(options.otlpEndpoint).toBe('http://otel-collector:4318');
        const telemetry: Telemetry = startTelemetry({
          ...options,
          stdout: (line) => lines.push(line),
          exporters: { logs: memory.logs, spans: memory.spans },
        });
        const shutdown = telemetry.shutdown;
        return {
          ...telemetry,
          shutdown: async () => {
            order.push('shutdown');
            await shutdown();
          },
        };
      },
      connect: connectNatsBus,
      exit: (code) => {
        order.push('exit');
        exitCode = code;
      },
    });

    expect(agent).toBeNull();
    expect(exitCode).toBe(1);
    expect(order).toEqual(['shutdown', 'exit']);

    const last = memory.logRecords.at(-1);
    expect(last?.severityText).toBe('error');
    expect(last?.spanContext?.traceId).toBe(TRACE);
    expect(last?.attributes).toMatchObject({ swarmId: SWARM, agentId: 'agent-2' });
    expect(String(last?.attributes['exception.message'])).not.toBe('');

    const record = LogRecord.parse(JSON.parse(lines.at(-1) ?? '{}'));
    expect(record).toMatchObject({
      level: 'error',
      service: 'agent',
      msg: 'agent start failed',
      traceId: TRACE,
      swarmId: SWARM,
      agentId: 'agent-2',
    });
    expect(record.err?.message).toBeTruthy();

    const start = memory.finishedSpans.find((s) => s.name === 'agent.start');
    expect(start?.spanContext().traceId).toBe(TRACE);
    expect(start?.status.code).toBe(2);
    // Текст роли в логи не попадает (REQ-016-10).
    expect(lines.join('\n')).not.toContain('Проверяет текст');
  });
});
