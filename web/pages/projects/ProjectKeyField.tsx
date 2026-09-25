import { AlertCircleIcon, CheckCircle2Icon } from 'lucide-react';
import { LIMITS } from '@shared/constants';
import { Spinner } from '@web/components/common/Spinner';
import { Input } from '@web/components/ui/input';
import { normalizeKeyInput, type KeyAvailability } from './keyAvailability';

/**
 * The project key input with a live preview of refs (`KEY-1`, `KEY#1`) and a uniqueness check
 * against the team's other projects. Used by the New project dialog and project settings.
 */

export interface ProjectKeyInputProps {
  id: string;
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  invalid?: boolean;
  describedBy?: string;
}

export function ProjectKeyInput({
  id,
  value,
  onChange,
  disabled,
  invalid,
  describedBy,
}: ProjectKeyInputProps) {
  return (
    <Input
      id={id}
      value={value}
      onChange={(event) => onChange(normalizeKeyInput(event.target.value))}
      disabled={disabled}
      aria-invalid={invalid ? true : undefined}
      aria-describedby={describedBy}
      autoComplete="off"
      spellCheck={false}
      maxLength={LIMITS.projectKey.max}
      placeholder="KEY"
      className="font-mono tracking-wider uppercase"
    />
  );
}

export interface KeyStatusProps {
  keyValue: string;
  availability: KeyAvailability;
  /** Offered when the key is taken. */
  onUseSuggestion?: (suggestion: string) => void;
}

/** The line under the key input: availability, and the refs the key produces. */
export function KeyStatus({ keyValue, availability, onUseSuggestion }: KeyStatusProps) {
  const preview = keyValue ? (
    <span className="text-muted-foreground">
      Tasks <span className="font-mono text-foreground">{keyValue}-1</span>, issues{' '}
      <span className="font-mono text-foreground">{keyValue}#1</span>
    </span>
  ) : (
    <span className="text-muted-foreground">
      2–6 letters or digits, starting with a letter. Used in refs like KEY-12.
    </span>
  );
  return (
    <span className="flex flex-wrap items-center gap-x-2 gap-y-1" aria-live="polite">
      {availability.state === 'checking' ? (
        <span className="inline-flex items-center gap-1 text-muted-foreground">
          <Spinner className="size-3" /> Checking…
        </span>
      ) : null}
      {availability.state === 'available' ? (
        <span className="inline-flex items-center gap-1 text-emerald-700 dark:text-emerald-400">
          <CheckCircle2Icon className="size-3.5" aria-hidden="true" /> Available
        </span>
      ) : null}
      {availability.state === 'taken' || availability.state === 'invalid' ? (
        <span className="inline-flex items-center gap-1 text-destructive">
          <AlertCircleIcon className="size-3.5" aria-hidden="true" /> {availability.message}
          {availability.state === 'taken' && onUseSuggestion ? (
            <button
              type="button"
              className="ml-1 font-medium text-foreground underline underline-offset-2 hover:text-primary"
              onClick={() => onUseSuggestion(availability.suggestion)}
            >
              Use {availability.suggestion}
            </button>
          ) : null}
        </span>
      ) : null}
      {availability.state === 'invalid' ? null : preview}
    </span>
  );
}
