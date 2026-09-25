/** Normalises a typed URL: adds https:// to bare domains; rejects script and data URLs. */
export function normalizeHref(input: string): string | null {
  const value = input.trim();
  if (!value) return null;
  if (/^(javascript|data|vbscript):/i.test(value)) return null;
  if (/^[a-z][a-z0-9+.-]*:/i.test(value) || value.startsWith('/') || value.startsWith('#')) {
    return value;
  }
  if (/^[\w.+-]+@[\w-]+(\.[\w-]+)+$/.test(value)) return `mailto:${value}`;
  return `https://${value}`;
}
