import type { CSSProperties } from 'react';

/** Tint derived from an entity color; the text stays the foreground color, readable in both themes. */
export function tintStyle(color: string | null | undefined): CSSProperties {
  const base = color ?? 'var(--muted-foreground)';
  return {
    borderColor: `color-mix(in oklab, ${base} 45%, transparent)`,
    backgroundColor: `color-mix(in oklab, ${base} 14%, transparent)`,
  };
}
