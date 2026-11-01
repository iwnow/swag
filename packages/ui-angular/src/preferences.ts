import type { Preferences } from '@swag/ui-core';

// Спека 014, 4.12: адаптер Preferences на localStorage. Хранилище недоступно (приватный режим, заблокированные данные сайта):
// get — null, set молча, выбор живёт до перезагрузки.
export const preferences: Preferences = {
  get(key) {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(key, value);
    } catch {
      // хранилище недоступно: значение не сохраняется
    }
  },
};
