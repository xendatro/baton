import { CheckCircle2Icon, XCircleIcon } from 'lucide-react';
import { LIMITS } from '@shared/constants';
import { Spinner } from '@web/components/common/Spinner';
import { Input } from '@web/components/ui/input';
import { FormField } from './FormField';
import type { UsernameCheck } from './useUsernameAvailability';

export interface UsernameFieldProps {
  value: string;
  onChange: (value: string) => void;
  check: UsernameCheck;
  /** Error from submitting (overrides the live check). */
  error?: string | null;
  autoFocus?: boolean;
}

export function UsernameField({ value, onChange, check, error, autoFocus }: UsernameFieldProps) {
  const liveError = check.status === 'invalid' || check.status === 'taken' ? check.message : null;
  return (
    <FormField
      label="Username"
      error={error ?? liveError}
      hint={
        check.status === 'available'
          ? check.message
          : `${LIMITS.username.min}–${LIMITS.username.max} characters: lowercase letters, digits and underscores.`
      }
    >
      {(field) => (
        <div className="relative">
          <span className="pointer-events-none absolute inset-y-0 left-3 flex items-center text-sm text-muted-foreground">
            @
          </span>
          <Input
            {...field}
            value={value}
            onChange={(event) => onChange(event.target.value.toLowerCase())}
            autoComplete="username"
            autoCapitalize="none"
            spellCheck={false}
            maxLength={LIMITS.username.max}
            autoFocus={autoFocus}
            className="pr-9 pl-7"
          />
          <span className="absolute inset-y-0 right-3 flex items-center" aria-live="polite">
            {check.status === 'checking' ? <Spinner label="Checking availability" /> : null}
            {check.status === 'available' ? (
              <CheckCircle2Icon
                className="size-4 text-emerald-600 dark:text-emerald-400"
                aria-label="Available"
              />
            ) : null}
            {check.status === 'taken' ? (
              <XCircleIcon className="size-4 text-destructive" aria-label="Taken" />
            ) : null}
          </span>
        </div>
      )}
    </FormField>
  );
}
