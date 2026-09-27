import { UndoIcon } from 'lucide-react';
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
import { errorMessage } from '@web/lib/api';

/**
 * Sending a task back (BAT-27): pick one of the earlier stages its stage allows, then give the
 * required reason. It is stored on the stage's new visit, posted in the thread and given to whoever
 * works on it next. The task page's Send back…, Request changes and board drops use it.
 */

export interface SendBackStage {
  id: string;
  name: string;
}

export interface SendBackResult {
  statusId: string;
  reason: string;
}

export interface SendBackDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The stage it is in. */
  from: string;
  /** The stages it may go back to, nearest first. */
  stages: readonly SendBackStage[];
  /** Preselected stage (default: the nearest one). */
  initialStageId?: string | undefined;
  /** Prefilled reason (e.g. the Request changes comment). */
  initialReason?: string | undefined;
  title?: string;
  confirmLabel?: string;
  onConfirm: (result: SendBackResult) => Promise<unknown>;
}

export function SendBackDialog(props: SendBackDialogProps) {
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent className="sm:max-w-md" data-testid="send-back-dialog">
        {props.open ? <SendBackForm {...props} /> : null}
      </DialogContent>
    </Dialog>
  );
}

function SendBackForm({
  from,
  stages,
  initialStageId,
  initialReason,
  title = 'Send back',
  confirmLabel = 'Send back',
  onConfirm,
  onOpenChange,
}: SendBackDialogProps) {
  const id = useId();
  const [statusId, setStatusId] = useState(
    initialStageId && stages.some((stage) => stage.id === initialStageId)
      ? initialStageId
      : (stages[0]?.id ?? ''),
  );
  const [reason, setReason] = useState(initialReason ?? '');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const target = stages.find((stage) => stage.id === statusId);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!target) {
      setError('Pick the stage to send it back to.');
      return;
    }
    if (!reason.trim()) {
      setError('Give a reason: it is posted on the task and shown to whoever works on it next.');
      return;
    }
    setError(null);
    setPending(true);
    onConfirm({ statusId: target.id, reason: reason.trim() }).then(
      () => {
        setPending(false);
        onOpenChange(false);
      },
      (cause: unknown) => {
        setPending(false);
        setError(errorMessage(cause));
      },
    );
  };

  return (
    <form onSubmit={submit} className="grid gap-4" noValidate>
      <DialogHeader>
        <DialogTitle>{title}</DialogTitle>
        <DialogDescription>
          From {from}, back to an earlier stage. Its earlier approvals are cleared and its exit
          criteria need new evidence.
        </DialogDescription>
      </DialogHeader>
      {stages.length > 1 ? (
        <fieldset className="grid gap-1.5">
          <legend className="mb-1.5 text-sm font-medium">Send it back to</legend>
          {stages.map((stage) => (
            <label key={stage.id} className="flex items-center gap-2 text-sm">
              <input
                type="radio"
                name={`${id}-stage`}
                value={stage.id}
                checked={statusId === stage.id}
                onChange={() => setStatusId(stage.id)}
                className="size-4 accent-amber-600"
              />
              {stage.name}
            </label>
          ))}
        </fieldset>
      ) : (
        <p className="text-sm">
          Back to <strong>{target?.name}</strong>
        </p>
      )}
      <div className="grid gap-1.5">
        <Label htmlFor={`${id}-reason`}>Reason</Label>
        <Textarea
          id={`${id}-reason`}
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          maxLength={PIPELINE_LIMITS.comment}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? `${id}-error` : undefined}
          placeholder="What has to change (required)"
          autoFocus
        />
      </div>
      {error ? (
        <p id={`${id}-error`} role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
      <DialogFooter>
        <Button
          type="button"
          variant="outline"
          onClick={() => onOpenChange(false)}
          disabled={pending}
        >
          Cancel
        </Button>
        <Button
          type="submit"
          disabled={pending}
          className="bg-amber-500 text-amber-950 hover:bg-amber-500/90 dark:bg-amber-400 dark:hover:bg-amber-400/90"
        >
          {pending ? <Spinner /> : <UndoIcon aria-hidden="true" />}
          {confirmLabel}
          {target ? ` to ${target.name}` : ''}
        </Button>
      </DialogFooter>
    </form>
  );
}
