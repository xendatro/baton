import type { CSSProperties } from 'react';
import { useTheme } from './theme';

/** Tint derived from an entity color; the text stays the foreground color, readable in both themes. */
export function tintStyle(color: string | null | undefined): CSSProperties {
  const base = color ?? 'var(--muted-foreground)';
  return {
    borderColor: `color-mix(in oklab, ${base} 45%, transparent)`,
    backgroundColor: `color-mix(in oklab, ${base} 14%, transparent)`,
  };
}

// ---------------------------------------------------------------------------------------------
// Readable text in an entity color (role-colored names, SPEC §1.3)
// ---------------------------------------------------------------------------------------------

type Rgb = [number, number, number];

/** WCAG AA for normal text. */
export const MIN_TEXT_CONTRAST = 4.5;

/**
 * The surfaces colored text sits on in each theme (globals.css): background, card and the muted
 * row/hover tints. Text must reach AA on all of them.
 */
const SURFACES: Record<'light' | 'dark', string[]> = {
  light: ['#ffffff', '#f4f4f5'],
  dark: ['#09090b', '#18181b', '#27272a'],
};

/** What colored text is mixed toward until it is readable: the theme's foreground. */
const FOREGROUND: Record<'light' | 'dark', string> = { light: '#09090b', dark: '#fafafa' };

function parseHex(color: string): Rgb | null {
  const match = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color.trim());
  if (!match?.[1]) return null;
  const hex =
    match[1].length === 3 ? [...match[1]].map((digit) => digit + digit).join('') : match[1];
  return [0, 2, 4].map((index) => parseInt(hex.slice(index, index + 2), 16)) as Rgb;
}

function toHex(rgb: Rgb): string {
  return `#${rgb.map((value) => Math.round(value).toString(16).padStart(2, '0')).join('')}`;
}

function luminance([r, g, b]: Rgb): number {
  const linear = (value: number) => {
    const c = value / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
}

/** WCAG contrast ratio of two hex colors (1–21). */
export function contrastRatio(a: string, b: string): number {
  const [x, y] = [parseHex(a), parseHex(b)];
  if (!x || !y) return 1;
  const [light, dark] = [luminance(x), luminance(y)].sort((p, q) => q - p) as [number, number];
  return (light + 0.05) / (dark + 0.05);
}

const cache = new Map<string, string>();

/**
 * `color` as text that reaches AA contrast on the theme's surfaces: unchanged when it already
 * does, otherwise mixed toward the theme's foreground (darker in light mode, lighter in dark mode)
 * just enough, so the hue stays recognisable. Non-hex values are returned as they are.
 */
export function readableTextColor(color: string, theme: 'light' | 'dark'): string {
  const key = `${theme}:${color}`;
  const cached = cache.get(key);
  if (cached) return cached;
  const rgb = parseHex(color);
  const target = parseHex(FOREGROUND[theme]) as Rgb;
  let result = color;
  if (rgb) {
    for (let step = 0; step <= 20; step += 1) {
      const t = step / 20;
      const mixed = toHex(
        rgb.map((value, index) => value + ((target[index] ?? value) - value) * t) as Rgb,
      );
      result = mixed;
      if (SURFACES[theme].every((surface) => contrastRatio(mixed, surface) >= MIN_TEXT_CONTRAST)) {
        break;
      }
    }
  }
  cache.set(key, result);
  return result;
}

/** Text style for an entity color (role-colored names), readable in the current theme. */
export function useReadableTextColor(color: string | null | undefined): CSSProperties | undefined {
  const { resolvedTheme } = useTheme();
  return color ? { color: readableTextColor(color, resolvedTheme) } : undefined;
}
