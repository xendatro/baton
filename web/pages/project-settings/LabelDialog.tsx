import { useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import { COLOR_PALETTE, LIMITS } from '@shared/constants';
import {
  createLabelInputSchema,
  type CreateLabelInput,
  type Label as LabelEntity,
} from '@shared/schemas/projects';
import { FormError, FormField } from '@web/components/auth/FormField';
import { LabelChip } from '@web/components/common/LabelChip';
import { Spinner } from '@web/components/common/Spinner';
import { ColorPicker } from '@web/components/pickers/ColorPicker';
import { Button } from '@web/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@web/components/ui/dialog';
import { Input } from '@web/components/ui/input';
import { errorMessage, isApiError } from '@web/lib/api';
import { fieldErrors } from '@web/lib/forms';
import { useCreateLabel, useLabels, useUpdateLabel } from '../projects/queries';

/**
 * The New label / Edit label dialog of project settings → Labels, also opened by "New label…"
 * in the right-click menus' Labels submenu (BAT-40), where `onCreated` applies the new label.
 */

export type LabelEditing = { mode: 'create' } | { mode: 'edit'; label: LabelEntity } | null;
type Editing = LabelEditing;

function nextColor(existing: readonly LabelEntity[]): string {
  const used = new Set(existing.map((label) => label.color));
  return (COLOR_PALETTE.slice(1).find((color) => !used.has(color.hex)) ?? COLOR_PALETTE[0]).hex;
}

/** "New label…" outside the settings page: the same dialog, knowing the project's labels itself. */
export function NewLabelDialog({
  projectId,
  open,
  onClose,
  onCreated,
}: {
  projectId: string;
  open: boolean;
  onClose: () => void;
  onCreated?: (label: LabelEntity) => void;
}) {
  const labels = useLabels(projectId);
  return (
    <LabelDialog
      projectId={projectId}
      editing={open ? { mode: 'create' } : null}
      existing={labels.data ?? []}
      onClose={onClose}
      onCreated={onCreated}
    />
  );
}

export function LabelDialog({
  projectId,
  editing,
  existing,
  onClose,
  onCreated,
}: {
  projectId: string;
  editing: Editing;
  existing: readonly LabelEntity[];
  onClose: () => void;
  /** After a label is created (not edited). */
  onCreated?: (label: LabelEntity) => void;
}) {
  return (
    <Dialog open={editing !== null} onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent className="sm:max-w-md">
        {editing ? (
          <LabelForm
            projectId={projectId}
            editing={editing}
            existing={existing}
            onClose={onClose}
            onCreated={onCreated}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

type Field = 'name' | 'description' | 'color';

function LabelForm({
  projectId,
  editing,
  existing,
  onClose,
  onCreated,
}: {
  projectId: string;
  editing: NonNullable<Editing>;
  existing: readonly LabelEntity[];
  onClose: () => void;
  onCreated?: ((label: LabelEntity) => void) | undefined;
}) {
  const create = useCreateLabel(projectId);
  const update = useUpdateLabel(projectId);
  const initial = editing.mode === 'edit' ? editing.label : null;
  const [name, setName] = useState(initial?.name ?? '');
  const [description, setDescription] = useState(initial?.description ?? '');
  const [color, setColor] = useState(initial?.color ?? nextColor(existing));
  const [errors, setErrors] = useState<Partial<Record<Field, string>>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const pending = create.isPending || update.isPending;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (pending) return;
    setFormError(null);
    const input: CreateLabelInput = { name, description, color };
    const parsed = createLabelInputSchema.safeParse(input);
    if (!parsed.success) {
      setErrors(fieldErrors<Field>(parsed.error));
      return;
    }
    setErrors({});
    const onError = (cause: Error) => {
      if (isApiError(cause) && cause.code === 'conflict') setErrors({ name: cause.message });
      else setFormError(errorMessage(cause));
    };
    if (initial) {
      update.mutate(
        { id: initial.id, input: parsed.data },
        {
          onSuccess: (label) => {
            toast.success(`Saved ${label.name}`);
            onClose();
          },
          onError,
        },
      );
    } else {
      create.mutate(parsed.data, {
        onSuccess: (label) => {
          toast.success(`Created ${label.name}`);
          onClose();
          onCreated?.(label);
        },
        onError,
      });
    }
  };

  return (
    <form onSubmit={submit} className="grid gap-4" noValidate>
      <DialogHeader>
        <DialogTitle>{initial ? 'Edit label' : 'New label'}</DialogTitle>
        <DialogDescription>
          {initial
            ? `Changes apply everywhere ${initial.name} is used.`
            : 'Available to every issue and task in this project.'}
        </DialogDescription>
      </DialogHeader>
      <div className="flex min-h-10 items-center justify-center rounded-md border border-dashed bg-muted/30 px-3 py-3">
        <LabelChip label={{ name: name.trim() || 'Label preview', color }} />
      </div>
      <div className="flex items-end gap-3">
        <FormField label="Name" error={errors.name} className="min-w-0 flex-1">
          {(field) => (
            <Input
              {...field}
              value={name}
              onChange={(event) => setName(event.target.value)}
              maxLength={LIMITS.labelName.max}
              placeholder="bug"
              autoFocus
              autoComplete="off"
            />
          )}
        </FormField>
        <div className="grid gap-1.5 pb-px">
          <span className="text-sm leading-none font-medium" aria-hidden="true">
            Color
          </span>
          <ColorPicker value={color} onChange={setColor} label="Label color">
            <Button
              type="button"
              variant="outline"
              size="icon"
              aria-label={`Label color: ${color}`}
            >
              <span className="size-4 rounded-full border" style={{ backgroundColor: color }} />
            </Button>
          </ColorPicker>
        </div>
      </div>
      <FormField
        label="Description"
        error={errors.description}
        hint={`Optional · shown when hovering the label (${description.length}/${LIMITS.labelDescription.max})`}
      >
        {(field) => (
          <Input
            {...field}
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            maxLength={LIMITS.labelDescription.max}
            placeholder="Something isn’t working"
            autoComplete="off"
          />
        )}
      </FormField>
      <FormError message={formError} />
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onClose} disabled={pending}>
          Cancel
        </Button>
        <Button type="submit" disabled={pending || !name.trim()}>
          {pending ? <Spinner /> : null}
          {initial ? 'Save label' : 'Create label'}
        </Button>
      </DialogFooter>
    </form>
  );
}
