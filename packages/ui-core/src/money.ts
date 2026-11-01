// Спека 004, 4.8: деньги — целочисленные micro-USD; функции без зависимостей от остальных модулей ядра.

// Микродоллары → строка с 4 знаками, округление вверх; целочисленная арифметика.
export function formatUsd(microUsd: number): string {
  const units = Math.floor((microUsd + 99) / 100);
  return `$${Math.floor(units / 10000)}.${String(units % 10000).padStart(4, '0')}`;
}

// Вход поля «Бюджет, $» → Math.round(usd × 10⁶). Некорректный ввод → NaN, отсекает SwarmCreateRequest.
export function usdToMicro(usd: string): number {
  const text = usd.trim();
  if (!/^\d+(\.\d+)?$/.test(text)) return NaN;
  return Math.round(Number(text) * 1e6);
}
