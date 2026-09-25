import { useQuery } from '@tanstack/react-query';
import { usernameSchema } from '@shared/schemas/common';
import { authClient, unwrapAuth } from '@web/lib/auth';
import { queryKeys } from '@web/lib/queryKeys';
import { useDebouncedValue } from '@web/lib/useDebouncedValue';

export type UsernameStatus = 'idle' | 'invalid' | 'checking' | 'available' | 'taken' | 'unknown';

export interface UsernameCheck {
  status: UsernameStatus;
  /** Validation message (invalid) or availability message. */
  message: string | null;
}

/** Local validation (shared schema) plus a debounced availability check against Better Auth. */
export function useUsernameAvailability(username: string): UsernameCheck {
  const value = username.trim().toLowerCase();
  const debounced = useDebouncedValue(value, 350);
  const parsed = usernameSchema.safeParse(value);
  const debouncedValid = usernameSchema.safeParse(debounced).success;
  const availability = useQuery({
    queryKey: queryKeys.usernameAvailable(debounced),
    queryFn: async () =>
      unwrapAuth(await authClient.isUsernameAvailable({ username: debounced })).available,
    enabled: debouncedValid,
    staleTime: 30_000,
    retry: false,
  });

  if (!value) return { status: 'idle', message: null };
  if (!parsed.success) {
    return { status: 'invalid', message: parsed.error.issues[0]?.message ?? 'Invalid username' };
  }
  if (debounced !== value || availability.isPending) return { status: 'checking', message: null };
  if (availability.isError) return { status: 'unknown', message: null };
  return availability.data
    ? { status: 'available', message: `@${value} is available` }
    : { status: 'taken', message: `@${value} is taken` };
}
