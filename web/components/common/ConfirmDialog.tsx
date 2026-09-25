import { useId, useState, type ReactNode } from 'react';
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@web/components/ui/alert-dialog';
import { Button } from '@web/components/ui/button';
import { Input } from '@web/components/ui/input';
import { Label } from '@web/components/ui/label';
import { errorMessage } from '@web/lib/api';
import { Spinner } from './Spinner';

export interface ConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Red confirm button. */
  destructive?: boolean;
  /**
   * Text the user must type to enable the confirm button (e.g. the team's slug), for actions
   * that are hard to undo.
   */
  typedConfirmation?: string;
  /** May be async: the dialog stays open with a spinner until it settles, and shows its error. */
  onConfirm: () => void | Promise<void>;
}

export function ConfirmDialog(props: ConfirmDialogProps) {
  const { open, onOpenChange } = props;
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      {/* Remounted on every open so the typed text and error start empty. */}
      {open ? <ConfirmDialogBody {...props} /> : null}
    </AlertDialog>
  );
}

function ConfirmDialogBody({
  onOpenChange,
  title,
  description,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  destructive = false,
  typedConfirmation,
  onConfirm,
}: ConfirmDialogProps) {
  const inputId = useId();
  const [typed, setTyped] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const blocked = typedConfirmation !== undefined && typed.trim() !== typedConfirmation;

  async function confirm() {
    if (blocked || pending) return;
    setPending(true);
    setError(null);
    try {
      await onConfirm();
      onOpenChange(false);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setPending(false);
    }
  }

  return (
    <AlertDialogContent>
      <form
        className="grid gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          void confirm();
        }}
      >
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          {description ? <AlertDialogDescription>{description}</AlertDialogDescription> : null}
        </AlertDialogHeader>
        {typedConfirmation !== undefined ? (
          <div className="grid gap-2">
            <Label htmlFor={inputId} className="font-normal">
              Type <span className="font-mono font-semibold">{typedConfirmation}</span> to confirm
            </Label>
            <Input
              id={inputId}
              value={typed}
              onChange={(event) => setTyped(event.target.value)}
              autoComplete="off"
              autoFocus
            />
          </div>
        ) : null}
        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}
        <AlertDialogFooter>
          <AlertDialogCancel type="button" disabled={pending}>
            {cancelLabel}
          </AlertDialogCancel>
          <Button
            type="submit"
            variant={destructive ? 'destructive' : 'default'}
            disabled={blocked || pending}
          >
            {pending ? <Spinner /> : null}
            {confirmLabel}
          </Button>
        </AlertDialogFooter>
      </form>
    </AlertDialogContent>
  );
}
