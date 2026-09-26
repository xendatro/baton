import { LinkIcon } from 'lucide-react';
import { useId, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router';
import { Button } from '@web/components/ui/button';
import { Input } from '@web/components/ui/input';
import { cn } from '@web/lib/utils';
import { parseInviteInput } from './invite';

/** Paste box for an invite link or code; opens the join page for it. */
export function JoinWithLink({ className }: { className?: string }) {
  const navigate = useNavigate();
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);
  const inputId = useId();
  const errorId = useId();

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const code = parseInviteInput(value);
    if (!code) {
      setError('Paste an invite link (…/join/AbCd123456) or its 10-character code.');
      return;
    }
    void navigate(`/join/${code}`);
  };

  return (
    <form onSubmit={submit} className={cn('space-y-2', className)} noValidate>
      <label htmlFor={inputId} className="sr-only">
        Invite link or code
      </label>
      <div className="flex gap-2">
        <div className="relative min-w-0 flex-1">
          <LinkIcon
            aria-hidden="true"
            className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
          />
          <Input
            id={inputId}
            value={value}
            onChange={(event) => {
              setValue(event.target.value);
              setError(null);
            }}
            placeholder="Paste an invite link"
            autoComplete="off"
            spellCheck={false}
            className="pl-8"
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? errorId : undefined}
          />
        </div>
        <Button type="submit" variant="outline" disabled={!value.trim()}>
          Join
        </Button>
      </div>
      {error ? (
        <p id={errorId} className="text-xs text-destructive" role="alert">
          {error}
        </p>
      ) : null}
    </form>
  );
}
