// Сверка ledger с провайдером: спека 004, 4.5 и 4.13, REQ-004-19. Запуск: `npm run money:report -- [--swarm <uuid>] [--since <ISO>]`.
import { pathToFileURL } from 'node:url';
import pg from 'pg';
import { ledgerReport, type LedgerReport } from '@swag/adapter-postgres';
import { BaseConfig, ConfigError, loadConfig } from '@swag/config';
import type { ChargeBasis } from '@swag/contracts';
import { formatUsd } from '@swag/ui-core';
import { onHost } from './host-url.ts';

const USAGE = 'Использование: npm run money:report -- [--swarm <uuid>] [--since <ISO>]';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

export interface MoneyReportFilter {
  swarmId?: string;
  since?: Date;
}

// Спека 004, 4.13: разбор `--swarm <uuid>` и `--since <ISO>`; ошибка ввода — сообщение и код выхода 1.
export function parseMoneyReportArgs(args: string[]): MoneyReportFilter {
  const filter: MoneyReportFilter = {};
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index] ?? '';
    const value = args[index + 1];
    if (value === undefined) throw new Error(`${flag}: нужно значение\n${USAGE}`);
    if (flag === '--swarm') {
      if (!UUID_RE.test(value)) throw new Error(`--swarm: не uuid: ${value}`);
      filter.swarmId = value;
    } else if (flag === '--since') {
      if (Number.isNaN(Date.parse(value))) throw new Error(`--since: не дата: ${value}`);
      filter.since = new Date(value);
    } else {
      throw new Error(`неизвестный аргумент: ${flag}\n${USAGE}`);
    }
  }
  return filter;
}

const basisPart = (report: LedgerReport, basis: ChargeBasis): string => {
  const { calls, microUsd } = report.byBasis[basis];
  return calls > 0 ? `${basis} ${calls} / ${formatUsd(microUsd)}` : `${basis} 0`;
};

// Спека 004, 4.13: три строки отчёта. Разница — (charged − provider) / provider × 100, при provider = 0 — n/a.
export function formatMoneyReport(report: LedgerReport): string {
  const withProviderCost = report.calls - report.callsWithoutProviderCost;
  const provider = report.providerCostMicroUsd;
  const charged = report.chargedWithProviderCostMicroUsd;
  let difference = 'n/a';
  if (provider !== 0) {
    const percent = Math.round(((charged - provider) / provider) * 10_000) / 100;
    difference = `${percent >= 0 ? '+' : ''}${percent.toFixed(2)}%`;
  }
  return [
    `calls ${report.calls} · charged ${formatUsd(report.chargedMicroUsd)} (${basisPart(report, 'usage')}, ${basisPart(report, 'estimate')}, ${basisPart(report, 'none')})`,
    `provider ${formatUsd(provider)} по ${withProviderCost} вызовам · без факта ${report.callsWithoutProviderCost}`,
    `charged vs provider по тем же вызовам: ${formatUsd(charged)} vs ${formatUsd(provider)} · ${difference}`,
  ].join('\n');
}

function readDatabaseUrl(): string {
  try {
    return loadConfig(BaseConfig.pick({ DATABASE_URL: true })).DATABASE_URL;
  } catch (error) {
    if (error instanceof ConfigError) fail(`${error.message}\nСкопируйте .env.example в .env.`);
    throw error;
  }
}

async function main(): Promise<void> {
  const filter = parseMoneyReportArgs(process.argv.slice(2));
  const pool = new pg.Pool({ connectionString: onHost(readDatabaseUrl()) });
  try {
    console.log(formatMoneyReport(await ledgerReport(pool, filter)));
  } finally {
    await pool.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => fail(error instanceof Error ? error.message : String(error)));
}
