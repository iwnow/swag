// Трактовка: код берётся из `error.code` (строка), иначе `'unknown'`. Модуль внутренний: `index.ts` его не реэкспортирует.
export function errorCode(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : 'unknown';
}
