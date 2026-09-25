import type { FieldChange } from '@shared/schemas/core';

/** Field-level changes of an activity row: `{ field: { from, to } }` with human-readable values. */
export type Changes = Record<string, FieldChange>;

/** Turns a stored value into what people read (status id → status name, Date → ISO string, …). */
export type ValueFormatter<V> = (value: V) => unknown;

export type Formatters<T> = { [K in keyof T]?: ValueFormatter<T[K]> };

/** Normalises a value for the log: Dates to ISO strings, undefined to null. */
export function readableValue(value: unknown): unknown {
  if (value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(readableValue);
  return value;
}

/**
 * Comparison key. Arrays of primitives are compared as sets (sorted), because they hold labels,
 * assignees or permissions where order carries no meaning.
 */
function canonical(value: unknown): string {
  if (Array.isArray(value)) {
    const items: unknown[] = value;
    if (items.every((item) => item === null || typeof item !== 'object')) {
      return JSON.stringify(items.map((item) => JSON.stringify(item)).sort());
    }
  }
  return JSON.stringify(value);
}

/**
 * Diffs `after` against `before`. Only keys present in `after` are compared, so callers can pass
 * their (partial) update input directly. Values go through the field's formatter (if any) and
 * `readableValue` before comparing, so the log never records a change that reads identically.
 */
export function diffFields<T extends object>(
  before: T,
  after: Partial<T>,
  formatters: Formatters<T> = {},
): Changes {
  const changes: Changes = {};
  for (const key of Object.keys(after) as Array<keyof T & string>) {
    const next = after[key];
    if (next === undefined) continue;
    const format: ValueFormatter<T[typeof key]> | undefined = formatters[key];
    const from = readableValue(format ? format(before[key]) : before[key]);
    const to = readableValue(format ? format(next) : next);
    if (canonical(from) !== canonical(to)) changes[key] = { from, to };
  }
  return changes;
}

/** A single change entry, e.g. `change('Open', 'Done')`. */
export function change(from: unknown, to: unknown): FieldChange {
  return { from: readableValue(from), to: readableValue(to) };
}

export function hasChanges(changes: Changes): boolean {
  return Object.keys(changes).length > 0;
}
