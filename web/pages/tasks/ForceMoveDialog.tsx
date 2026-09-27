import { useId, useState, type FormEvent } from 'react';
import { PIPELINE_LIMITS } from '@shared/schemas/pipelines';
import { Spinner } from '@web/components/common/Spinner';
import { Button } from '@web/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@web/components/ui/dialog';
import { Label } from '@web/components/ui/label';
import { Textarea } from '@web/components/ui/textarea';

/**
 * The team owner's or an administrator's override of the stage rules (design §5): the move the
 * rules block, what blocks it, and a required reason (recorded in the history as `task.forced`).
 */
export function ForceMoveDialog({
  open,
  onOpenChange,
  target,
  blockedBy,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  target: string;
  blockedBy: string;
  onConfirm: (reason: string) => Promise<unknown>;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        {open ? (
          <ForceForm
            target={target}
            blockedBy={blockedBy}
            onConfirm={onConfirm}
            onCancel={() => onOpenChange(false)}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function ForceForm({
  target,
  blockedBy,
  onConfirm,
  onCancel,
}: {
  target: string;
  blockedBy: string;
  onConfirm: (reason: string) => Promise<unknown>;
  onCancel: () => void;
}) {
  const id = useId();
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!reason.trim()) {
      setError('Give a reason: it is recorded in the task’s history.');
      return;
    }
    setPending(true);
    onConfirm(reason.trim()).then(
      () => setPending(false),
      () => setPending(false),
    );
  };
  return (
    <form onSubmit={submit} className="grid gap-4" noValidate>
      <DialogHeader>
        <DialogTitle>Force the move to {target}?</DialogTitle>
        <DialogDescription>The stage rules block it: {blockedBy}.</DialogDescription>
      </DialogHeader>
      <div className="grid gap-1.5">
        <Label htmlFor={id}>Reason</Label>
        <Textarea
          id={id}
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          maxLength={PIPELINE_LIMITS.reason}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? `${id}-error` : undefined}
          placeholder="Why it can’t wait for the rules (e.g. hotfix, reviewer away)"
          autoFocus
        />
        {error ? (
          <p id={`${id}-error`} role="alert" className="text-xs text-destructive">
            {error}
          </p>
        ) : null}
      </div>
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onCancel} disabled={pending}>
          Cancel
        </Button>
        <Button type="submit" variant="destructive" disabled={pending}>
          {pending ? <Spinner /> : null}
          Force move
        </Button>
      </DialogFooter>
    </form>
  );
}
