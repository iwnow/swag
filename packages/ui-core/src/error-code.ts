// Трактовка: код берётся из `error.code` (строка), иначе `'unknown'`. Модуль внутренний: `index.ts` его не реэкспортирует.
export function errorCode(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : 'unknown';
}

// Трактовка: 403 — код forbidden независимо от тела ответа (014, 4.6); остальное — код из error.code.
export function failureCode(failure: unknown): string {
  const { status } = (failure ?? {}) as { status?: unknown };
  return status === 403 ? 'forbidden' : errorCode(failure);
}
