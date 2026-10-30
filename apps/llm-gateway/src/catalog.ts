import { readFileSync } from 'node:fs';
import { ModelCatalog } from '@swag/contracts';
import type { PriceBook } from '@swag/llm-gateway-core';

// Спека 002, 4.7 и 4.9: каталог из LLM_CATALOG_PATH. Не читается или не проходит ModelCatalog — исключение.
export function readCatalog(path: string): ModelCatalog {
  const text = readFileSync(path, 'utf8');
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (error) {
    throw new Error(`invalid model catalog JSON: ${path}`, { cause: error });
  }
  const parsed = ModelCatalog.safeParse(json);
  if (!parsed.success) throw new Error(`invalid model catalog: ${path}`, { cause: parsed.error });
  return parsed.data;
}

// Спека 004, 4.4 и 4.9: текущий каталог процесса. PriceBook читает цены из него; обновление цен подменяет каталог целиком.
export interface CatalogHolder {
  book: PriceBook;
  current(): ModelCatalog;
  replace(next: ModelCatalog): void;
}

export function createCatalogHolder(initial: ModelCatalog): CatalogHolder {
  let current = initial;
  return {
    book: {
      prices(model) {
        const entry = current.models.find((candidate) => candidate.id === model);
        if (!entry) throw new Error(`model ${model} not in catalog`);
        return entry.prices;
      },
    },
    current: () => current,
    replace(next) {
      current = next;
    },
  };
}
