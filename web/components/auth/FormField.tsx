import { useId, type ReactNode } from 'react';
import { Label } from '@web/components/ui/label';
import { cn } from '@web/lib/utils';

export interface FieldRenderProps {
  id: string;
  'aria-invalid': true | undefined;
  'aria-describedby': string | undefined;
}

export interface FormFieldProps {
  label: string;
  /** Inline validation message. */
  error?: string | null;
  /** Helper text shown when there is no error. */
  hint?: ReactNode;
  /** Right side of the label row (e.g. "Forgot password?"). */
  aside?: ReactNode;
  className?: string;
  children: (props: FieldRenderProps) => ReactNode;
}

/** Label, control and inline message wired together with ids for screen readers. */
export function FormField({ label, error, hint, aside, className, children }: FormFieldProps) {
  const id = useId();
  const messageId = `${id}-message`;
  const message = error ?? hint;
  return (
    <div className={cn('grid gap-1.5', className)}>
      <div className="flex items-center justify-between gap-2">
        <Label htmlFor={id}>{label}</Label>
        {aside}
      </div>
      {children({
        id,
        'aria-invalid': error ? true : undefined,
        'aria-describedby': message ? messageId : undefined,
      })}
      {message ? (
        <p
          id={messageId}
          className={cn('text-xs', error ? 'text-destructive' : 'text-muted-foreground')}
          role={error ? 'alert' : undefined}
        >
          {message}
        </p>
      ) : null}
    </div>
  );
}

/** Form-level error (e.g. wrong password) above the submit button. */
export function FormError({ message }: { message: string | null | undefined }) {
  if (!message) return null;
  return (
    <p
      role="alert"
      className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
    >
      {message}
    </p>
  );
}
