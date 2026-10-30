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

// Спека 004, 4.4 и 4.9: PriceBook из цен каталога. Обновление из OpenRouter — T-9; до него цены — из models.json.
export function catalogPriceBook(catalog: ModelCatalog): PriceBook {
  return {
    prices(model) {
      const entry = catalog.models.find((candidate) => candidate.id === model);
      if (!entry) throw new Error(`model ${model} not in catalog`);
      return entry.prices;
    },
  };
}
