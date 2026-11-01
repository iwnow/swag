// Спека 014, 4.12: дата и время в интерфейсе — московское время, короткий формат (как в панели баланса и в админке).
export function formatDateTime(ts: string): string {
  return new Date(ts).toLocaleString('ru-RU', {
    timeZone: 'Europe/Moscow',
    dateStyle: 'short',
    timeStyle: 'short',
  });
}
