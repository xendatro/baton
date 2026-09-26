import { beforeAll, describe, expect, it } from 'vitest';
import { contrastRatio, MIN_TEXT_CONTRAST } from '@web/lib/colors';

/**
 * The theme tokens' text/background pairs reach WCAG AA (4.5:1) in both themes (UX-08, UX-12):
 * primary buttons and links, and secondary text on the surfaces it sits on.
 */

let css = '';

beforeAll(async () => {
  // Vitest stubs CSS imports (even `?raw`), so read the file; the web tsconfig has no Node types.
  const fsModule = 'node:fs';
  const fs = (await import(/* @vite-ignore */ fsModule)) as {
    readFileSync: (path: string, encoding: 'utf8') => string;
  };
  // Tests run from the repository root.
  css = fs.readFileSync('web/styles/globals.css', 'utf8');
});

/** Tokens of a `:root { … }` or `.dark { … }` block, as hex. */
function tokens(selector: ':root' | '.dark'): Record<string, string> {
  const start = css.indexOf(`${selector} {`);
  const block = css.slice(start, css.indexOf('}', start));
  const result: Record<string, string> = {};
  for (const match of block.matchAll(/--([\w-]+):\s*oklch\(([\d.]+) ([\d.]+) ([\d.]+)\);/g)) {
    const [, name, l, c, h] = match;
    if (name) result[name] = oklchToHex(Number(l), Number(c), Number(h));
  }
  return result;
}

function oklchToHex(l: number, c: number, h: number): string {
  const a = c * Math.cos((h * Math.PI) / 180);
  const b = c * Math.sin((h * Math.PI) / 180);
  const l_ = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m_ = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s_ = (l - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const linear = [
    4.0767416621 * l_ - 3.3077115913 * m_ + 0.2309699292 * s_,
    -1.2684380046 * l_ + 2.6097574011 * m_ - 0.3413193965 * s_,
    -0.0041960863 * l_ - 0.7034186147 * m_ + 1.707614701 * s_,
  ];
  return `#${linear
    .map((value) => {
      const v = Math.min(1, Math.max(0, value));
      const srgb = v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055;
      return Math.round(srgb * 255)
        .toString(16)
        .padStart(2, '0');
    })
    .join('')}`;
}

const PAIRS: Array<[text: string, background: string]> = [
  ['primary-foreground', 'primary'],
  ['primary', 'background'],
  ['primary', 'card'],
  ['sidebar-primary-foreground', 'sidebar-primary'],
  ['muted-foreground', 'background'],
  ['muted-foreground', 'card'],
  ['muted-foreground', 'muted'],
  ['muted-foreground', 'sidebar-accent'],
  ['foreground', 'background'],
];

describe('theme contrast', () => {
  for (const theme of [':root', '.dark'] as const) {
    it(`meets AA for text tokens in ${theme === ':root' ? 'light' : 'dark'} mode`, () => {
      const values = { ...tokens(':root'), ...(theme === '.dark' ? tokens('.dark') : {}) };
      for (const [text, background] of PAIRS) {
        const [fg, bg] = [values[text], values[background]];
        expect(fg && bg, `${text} / ${background} defined`).toBeTruthy();
        expect(
          contrastRatio(fg ?? '', bg ?? ''),
          `${text} (${fg}) on ${background} (${bg})`,
        ).toBeGreaterThanOrEqual(MIN_TEXT_CONTRAST);
      }
    });
  }
});
