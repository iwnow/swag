import { readFileSync } from 'node:fs';
import { ModelCatalog } from '@swag/contracts';

// Спека 002, 4.7 и 4.9: каталог из LLM_CATALOG_PATH. Не читается или не проходит ModelCatalog — исключение.
export function readCatalog(path: string): ModelCatalog {
  const parsed = ModelCatalog.safeParse(JSON.parse(readFileSync(path, 'utf8')));
  if (!parsed.success) throw new Error(`invalid model catalog: ${path}`, { cause: parsed.error });
  return parsed.data;
}
