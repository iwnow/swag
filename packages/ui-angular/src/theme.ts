import { Injectable, signal } from '@angular/core';

export type ThemeMode = 'system' | 'light' | 'dark';

const STORAGE_KEY = 'swag.theme';
const MODES: readonly ThemeMode[] = ['system', 'light', 'dark'];

function readStored(): ThemeMode {
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    return MODES.find((mode) => mode === value) ?? 'system';
  } catch {
    return 'system';
  }
}

function writeStored(mode: ThemeMode): void {
  try {
    localStorage.setItem(STORAGE_KEY, mode);
  } catch {
    // хранилище недоступно (приватный режим, заблокированные данные сайта): выбор живёт до перезагрузки
  }
}

// «system» — атрибута нет, тему выбирает prefers-color-scheme (tokens.css).
function applyToDocument(mode: ThemeMode): void {
  const root = document.documentElement;
  if (mode === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', mode);
}

@Injectable({ providedIn: 'root' })
export class ThemeService {
  private readonly current = signal<ThemeMode>(readStored());
  readonly mode = this.current.asReadonly();

  constructor() {
    applyToDocument(this.current());
  }

  setMode(mode: ThemeMode): void {
    this.current.set(mode);
    writeStored(mode);
    applyToDocument(mode);
  }
}
