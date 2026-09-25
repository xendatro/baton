import { LIMITS } from '@shared/constants';
import { projectKeySchema } from '@shared/schemas/common';
import { useDebouncedValue } from '@web/lib/useDebouncedValue';
import { useProjectKeyCheck } from './queries';

/** Keeps what a key may contain: letters and digits, uppercase, at most six characters. */
export function normalizeKeyInput(value: string): string {
  return value
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .slice(0, LIMITS.projectKey.max);
}

export type KeyAvailability =
  | { state: 'idle' }
  | { state: 'checking' }
  | { state: 'invalid'; message: string }
  | { state: 'taken'; message: string; suggestion: string }
  | { state: 'available' };

/** Validates `key` locally, then asks the server whether it is free (debounced). */
export function useKeyAvailability(
  teamId: string | null,
  key: string,
  options: { projectId?: string; currentKey?: string } = {},
): KeyAvailability {
  const debounced = useDebouncedValue(key, 250);
  const local = projectKeySchema.safeParse(key);
  const unchanged = options.currentKey !== undefined && key === options.currentKey;
  const check = useProjectKeyCheck(
    local.success && !unchanged ? teamId : null,
    debounced,
    options.projectId,
  );
  if (key === '') return { state: 'idle' };
  if (!local.success) {
    return { state: 'invalid', message: local.error.issues[0]?.message ?? 'Invalid key' };
  }
  if (unchanged) return { state: 'idle' };
  if (debounced !== key || check.isFetching || !check.data || check.data.key !== key) {
    return check.isError ? { state: 'idle' } : { state: 'checking' };
  }
  if (!check.data.available) {
    return {
      state: 'taken',
      message: check.data.message ?? 'Already used in this team',
      suggestion: check.data.suggestion,
    };
  }
  return { state: 'available' };
}
