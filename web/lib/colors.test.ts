import { describe, expect, it } from 'vitest';
import { COLOR_PALETTE } from '@shared/constants';
import { contrastRatio, MIN_TEXT_CONTRAST, readableTextColor } from './colors';

describe('readableTextColor (UX-06)', () => {
  it('computes WCAG contrast ratios', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 5);
    expect(contrastRatio('#22c55e', '#ffffff')).toBeCloseTo(2.28, 2);
  });

  it('makes every palette color readable as text in both themes', () => {
    const surfaces = { light: ['#ffffff', '#f4f4f5'], dark: ['#09090b', '#18181b', '#27272a'] };
    for (const theme of ['light', 'dark'] as const) {
      for (const { hex } of COLOR_PALETTE) {
        const text = readableTextColor(hex, theme);
        for (const surface of surfaces[theme]) {
          expect(
            contrastRatio(text, surface),
            `${hex} → ${text} on ${surface}`,
          ).toBeGreaterThanOrEqual(MIN_TEXT_CONTRAST);
        }
      }
    }
  });

  it('darkens in light mode, lightens in dark mode, and leaves readable colors alone', () => {
    const green = '#22c55e';
    const light = readableTextColor(green, 'light');
    const dark = readableTextColor(green, 'dark');
    expect(contrastRatio(light, '#ffffff')).toBeGreaterThanOrEqual(MIN_TEXT_CONTRAST);
    // Only as much as needed: still green, not black.
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(light.slice(i, i + 2), 16));
    expect(g).toBeGreaterThan((r ?? 0) + 20);
    expect(g).toBeGreaterThan((b ?? 0) + 20);
    // Green is already readable on the dark surfaces.
    expect(dark).toBe(green);
    expect(readableTextColor('#1e3a8a', 'light')).toBe('#1e3a8a');
    expect(readableTextColor('#1e3a8a', 'dark')).not.toBe('#1e3a8a');
    expect(readableTextColor('var(--x)', 'light')).toBe('var(--x)');
  });
});
