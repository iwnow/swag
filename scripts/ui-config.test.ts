import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const css = readFileSync(
  new URL('../packages/ui-angular/styles/tokens.css', import.meta.url),
  'utf8',
);

const colorNames = [
  'bg',
  'surface',
  'surface-2',
  'text',
  'text-muted',
  'border',
  'focus',
  'primary',
  'primary-text',
  'danger',
  'danger-text',
  'success',
  'warning',
].map((name) => `--swag-color-${name}`);
const otherNames = [
  '--swag-font-sans',
  '--swag-font-mono',
  ...['sm', 'md', 'lg', 'xl'].map((size) => `--swag-text-${size}`),
  ...[1, 2, 3, 4, 5, 6].map((step) => `--swag-space-${step}`),
  '--swag-radius-sm',
  '--swag-radius-md',
  '--swag-shadow-1',
];

const pairs = [
  ['text', 'bg'],
  ['text', 'surface'],
  ['text-muted', 'surface'],
  ['primary-text', 'primary'],
  ['danger-text', 'danger'],
] as const;

const declarations = (header: string): Map<string, string> => {
  const start = css.indexOf(`${header} {`);
  expect(start, `блок ${header}`).toBeGreaterThanOrEqual(0);
  const body = css.slice(start + header.length + 2, css.indexOf('}', start));
  const result = new Map<string, string>();
  for (const line of body.split(';')) {
    const colon = line.indexOf(':');
    if (colon > 0) result.set(line.slice(0, colon).trim(), line.slice(colon + 1).trim());
  }
  return result;
};

const themes = {
  light: declarations(':root'),
  dark: declarations(":root[data-theme='dark']"),
  darkBySystem: declarations(":root:not([data-theme='light'])"),
};

const luminance = (hex: string): number => {
  const [r, g, b] = [1, 3, 5].map((at) => {
    const channel = parseInt(hex.slice(at, at + 2), 16) / 255;
    return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
};

const contrast = (a: string, b: string): number => {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (light! + 0.05) / (dark! + 0.05);
};

const isHex = (value: string | undefined): boolean =>
  value !== undefined &&
  value.length === 7 &&
  value.startsWith('#') &&
  !Number.isNaN(Number(`0x${value.slice(1)}`));

describe('токены дизайн-системы (спека 014, 4.8)', () => {
  it('AC-014-10: у обеих тем есть все токены 4.8, цвета — #rrggbb', () => {
    for (const name of [...colorNames, ...otherNames]) {
      expect(themes.light.has(name), `светлая: ${name}`).toBe(true);
    }
    for (const name of [...colorNames, '--swag-shadow-1']) {
      expect(themes.dark.has(name), `тёмная: ${name}`).toBe(true);
    }
    for (const theme of [themes.light, themes.dark, themes.darkBySystem]) {
      for (const name of colorNames) expect(isHex(theme.get(name)), name).toBe(true);
    }
  });

  it('AC-014-10: тёмная тема по атрибуту и по системе совпадают', () => {
    expect([...themes.darkBySystem]).toEqual([...themes.dark]);
  });

  it('AC-014-10: пары REQ-014-21 дают контраст не ниже 4.5:1 в обеих темах', () => {
    for (const [themeName, theme] of Object.entries(themes)) {
      for (const [fg, bg] of pairs) {
        const ratio = contrast(theme.get(`--swag-color-${fg}`)!, theme.get(`--swag-color-${bg}`)!);
        expect(ratio, `${themeName}: ${fg}/${bg}`).toBeGreaterThanOrEqual(4.5);
      }
    }
  });
});
