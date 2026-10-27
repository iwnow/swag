import { afterEach, describe, expect, it } from 'vitest';
import { caller, closeAll, listenUrl, openGateway } from './support.ts';

// Спека 002, NFR-002-1 (раздел 6): задержка шлюза поверх апстрима на вызовах без потока.
// Это замер, а не проверка: порога нет, результат печатается и переносится в журнал спеки.
// Запуск: LLM_GATEWAY_BENCH=1 npx vitest run apps/llm-gateway/test/nfr-latency.test.ts (см. README пакета).

const ROUNDS = 200;
const WARMUP = 20;
const body = JSON.stringify({ model: 'chat-small', messages: [{ role: 'user', content: 'ping' }] });

afterEach(closeAll);

// Ранг по методу «ближайший»: p95 из 200 значений — 190-е по возрастанию.
function percentile(sorted: number[], p: number): number {
  return sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)] ?? NaN;
}

const round = (ms: number) => Math.round(ms * 100) / 100;

describe.skipIf(!process.env.LLM_GATEWAY_BENCH)('llm-gateway [bench]', () => {
  it('NFR-002-1: задержка шлюза поверх апстрима, вызовы без потока, p95 — разница с прямым вызовом', async () => {
    const gateway = await openGateway();
    const gatewayUrl = await listenUrl(gateway.app);
    const direct = `${gateway.fake.url}/v1/chat/completions`;
    const viaGateway = `${gatewayUrl}/v1/chat/completions`;

    // Прямой и через шлюз вызовы чередуются, чтобы дрейф машины попадал в обе выборки поровну.
    const directMs: number[] = [];
    const gatewayMs: number[] = [];
    for (let i = 0; i < WARMUP + ROUNDS; i++) {
      const directOne = await timed(direct, { 'content-type': 'application/json' });
      const via = await timed(viaGateway, { 'content-type': 'application/json', ...caller });
      if (i < WARMUP) continue;
      directMs.push(directOne);
      gatewayMs.push(via);
    }

    const sortedDirect = [...directMs].sort((a, b) => a - b);
    const sortedGateway = [...gatewayMs].sort((a, b) => a - b);
    const p95Direct = percentile(sortedDirect, 0.95);
    const p95Gateway = percentile(sortedGateway, 0.95);
    const result = {
      rounds: ROUNDS,
      p50DirectMs: round(percentile(sortedDirect, 0.5)),
      p95DirectMs: round(p95Direct),
      p50GatewayMs: round(percentile(sortedGateway, 0.5)),
      p95GatewayMs: round(p95Gateway),
      p95DiffMs: round(p95Gateway - p95Direct),
    };
    process.stdout.write(`NFR-002-1 ${JSON.stringify(result)}\n`);
    expect(directMs).toHaveLength(ROUNDS);
    expect(gatewayMs).toHaveLength(ROUNDS);
  }, 120_000);
});

// Один вызов: время от отправки до конца тела ответа; статус должен быть 200, иначе замер не имеет смысла.
async function timed(url: string, headers: Record<string, string>): Promise<number> {
  const started = performance.now();
  const response = await fetch(url, { method: 'POST', headers, body });
  await response.arrayBuffer();
  const elapsed = performance.now() - started;
  if (response.status !== 200) throw new Error(`замер: статус ${response.status} на ${url}`);
  return elapsed;
}
