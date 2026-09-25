import { useState } from 'react';
import { toast } from 'sonner';
import { LIMITS } from '@shared/constants';
import type { MeTeam } from '@shared/schemas/core';
import { createRoleInputSchema, type Role } from '@shared/schemas/teams';
import { FormError, FormField } from '@web/components/auth/FormField';
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
import { errorMessage } from '@web/lib/api';
import { useCreateRole } from '@web/pages/teams/api';

const DEFAULT_ROLE_COLOR = '#3b82f6';

export interface CreateRoleDialogProps {
  team: MeTeam;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (role: Role) => void;
}

/** Name and color of a new role; permissions are set in the role editor it opens next. */
export function CreateRoleDialog({ team, open, onOpenChange, onCreated }: CreateRoleDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm">
        {open ? (
          <CreateRoleForm
            team={team}
            onCancel={() => onOpenChange(false)}
            onCreated={(role) => {
              onOpenChange(false);
              onCreated(role);
            }}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function CreateRoleForm({
  team,
  onCancel,
  onCreated,
}: {
  team: MeTeam;
  onCancel: () => void;
  onCreated: (role: Role) => void;
}) {
  const createRole = useCreateRole(team.id);
  const [name, setName] = useState('');
  const [color, setColor] = useState<string>(DEFAULT_ROLE_COLOR);
  const [error, setError] = useState<string | null>(null);

  const submit = () => {
    const parsed = createRoleInputSchema.safeParse({ name, color });
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? 'Check the name');
      return;
    }
    setError(null);
    createRole.mutate(parsed.data, {
      onSuccess: (role) => {
        toast.success(`Created the ${role.name} role`);
        onCreated(role);
      },
    });
  };

  return (
    <form
      className="grid gap-5"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <DialogHeader>
        <DialogTitle>Create role</DialogTitle>
        <DialogDescription>
          New roles start without permissions, just above @everyone.
        </DialogDescription>
      </DialogHeader>
      <div className="flex items-end gap-2">
        <FormField label="Role name" error={error} className="flex-1">
          {(field) => (
            <Input
              {...field}
              value={name}
              onChange={(event) => {
                setName(event.target.value);
                setError(null);
              }}
              maxLength={LIMITS.roleName.max}
              placeholder="Moderator"
              autoComplete="off"
              autoFocus
            />
          )}
        </FormField>
        <div className={error ? 'mb-5' : undefined}>
          <ColorPicker value={color} onChange={setColor} label="Role color" align="end">
            <Button type="button" variant="outline" size="icon" aria-label={`Role color: ${color}`}>
              <span className="size-4 rounded-full border" style={{ backgroundColor: color }} />
            </Button>
          </ColorPicker>
        </div>
      </div>
      <FormError message={createRole.isError ? errorMessage(createRole.error) : null} />
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onCancel} disabled={createRole.isPending}>
          Cancel
        </Button>
        <Button type="submit" disabled={createRole.isPending || !name.trim()}>
          {createRole.isPending ? <Spinner /> : null}
          Create role
        </Button>
      </DialogFooter>
    </form>
  );
}
