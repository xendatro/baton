import { useQueryClient } from '@tanstack/react-query';
import { CrownIcon, LogOutIcon, Trash2Icon } from 'lucide-react';
import { useId, useState } from 'react';
import { useNavigate } from 'react-router';
import { toast } from 'sonner';
import type { MeTeam } from '@shared/schemas/core';
import { updateTeamInputSchema, type TeamDetail } from '@shared/schemas/teams';
import { FormError } from '@web/components/auth/FormField';
import { ConfirmDialog } from '@web/components/common/ConfirmDialog';
import { ErrorState } from '@web/components/common/ErrorState';
import { Spinner } from '@web/components/common/Spinner';
import { UserAvatar } from '@web/components/common/UserAvatar';
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
import { Label } from '@web/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@web/components/ui/select';
import { Skeleton } from '@web/components/ui/skeleton';
import { errorMessage, isApiError } from '@web/lib/api';
import { fieldErrors } from '@web/lib/forms';
import { queryKeys } from '@web/lib/queryKeys';
import { useDocumentTitle } from '@web/lib/title';
import {
  patchMeTeam,
  refreshTeam,
  restoreTeam,
  useDeleteTeam,
  useLeaveTeam,
  useMembers,
  useTeam,
  useTransferOwnership,
  useUpdateTeam,
} from '@web/pages/teams/api';
import {
  TeamFields,
  type TeamFieldErrors,
  type TeamFieldValues,
} from '@web/pages/teams/TeamFields';
import { useSettingsTeam } from './context';
import { SettingsCard, SettingsHeader, SettingsRow } from './SettingsSection';
import { UnsavedChangesBar } from './UnsavedChanges';
import { useUnsavedChangesGuard } from './useUnsavedChangesGuard';

/** General: the team's name, URL, description, icon and color, plus the danger zone. */
export default function GeneralSettingsPage() {
  const team = useSettingsTeam();
  const detail = useTeam(team.id);
  useDocumentTitle(['General', team.name]);

  return (
    <div className="space-y-10">
      <section>
        <SettingsHeader title="General" description="How the team appears across Baton." />
        {detail.isPending ? (
          <FormSkeleton />
        ) : detail.isError ? (
          <ErrorState
            title="Couldn’t load the team"
            error={detail.error}
            onRetry={() => void detail.refetch()}
          />
        ) : (
          <TeamForm key={detail.data.id} team={team} detail={detail.data} />
        )}
      </section>
      <DangerZone team={team} />
    </div>
  );
}

function toValues(detail: TeamDetail): TeamFieldValues {
  return {
    name: detail.name,
    slug: detail.slug,
    description: detail.description,
    icon: detail.icon,
    color: detail.color,
  };
}

function sameValues(a: TeamFieldValues, b: TeamFieldValues): boolean {
  return (
    a.name === b.name &&
    a.slug === b.slug &&
    a.description === b.description &&
    a.icon === b.icon &&
    a.color.toLowerCase() === b.color.toLowerCase()
  );
}

function TeamForm({ team, detail }: { team: MeTeam; detail: TeamDetail }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const updateTeam = useUpdateTeam(team.id);
  const canEdit = team.permissions.includes('MANAGE_TEAM');
  const [baseline, setBaseline] = useState(() => toValues(detail));
  const [values, setValues] = useState(baseline);
  const [syncedAt, setSyncedAt] = useState(detail.updatedAt);
  const [errors, setErrors] = useState<TeamFieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const dirty = !sameValues(values, baseline);
  // Someone else saved meanwhile: follow along unless the form has edits of its own.
  if (detail.updatedAt !== syncedAt && !dirty) {
    setSyncedAt(detail.updatedAt);
    setBaseline(toValues(detail));
    setValues(toValues(detail));
  }
  const guard = useUnsavedChangesGuard(dirty);

  const save = () => {
    const parsed = updateTeamInputSchema.safeParse(values);
    if (!parsed.success) {
      setErrors(fieldErrors<keyof TeamFieldValues>(parsed.error));
      return;
    }
    setErrors({});
    setFormError(null);
    updateTeam.mutate(parsed.data, {
      onSuccess: (saved) => {
        const next = toValues(saved);
        setBaseline(next);
        setValues(next);
        toast.success('Team settings saved');
        if (saved.slug !== team.slug) {
          guard.allowNavigation();
          patchMeTeam(queryClient, saved);
          void navigate(`/t/${saved.slug}/settings/general`, { replace: true });
        }
        void refreshTeam(queryClient, team.id);
      },
      onError: (error) => {
        if (isApiError(error) && error.code === 'conflict') setErrors({ slug: error.message });
        else if (isApiError(error) && error.code === 'validation_failed') {
          setErrors(error.fieldErrors);
        } else setFormError(errorMessage(error));
      },
    });
  };

  return (
    <form
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        if (dirty) save();
      }}
    >
      <SettingsCard className="p-4 sm:p-5">
        {!canEdit ? (
          <p className="mb-4 rounded-md border bg-muted/50 px-3 py-2 text-sm text-muted-foreground">
            You can view these settings. Changing them needs the Manage team permission.
          </p>
        ) : null}
        <TeamFields
          values={values}
          onChange={(patch) => {
            setValues((current) => ({ ...current, ...patch }));
            setErrors({});
          }}
          errors={errors}
          disabled={!canEdit || updateTeam.isPending}
          slugHint="Changing it breaks links that use the old URL."
        />
        {formError ? (
          <div className="mt-4">
            <FormError message={formError} />
          </div>
        ) : null}
      </SettingsCard>
      {canEdit ? (
        <UnsavedChangesBar
          dirty={dirty}
          saving={updateTeam.isPending}
          canSave={values.name.trim().length > 0}
          onSave={save}
          onReset={() => {
            setValues(baseline);
            setErrors({});
            setFormError(null);
          }}
        />
      ) : null}
      {guard.dialog}
    </form>
  );
}

function DangerZone({ team }: { team: MeTeam }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const deleteTeam = useDeleteTeam(team.id);
  const leaveTeam = useLeaveTeam(team.id);
  const [confirm, setConfirm] = useState<'delete' | 'leave' | 'transfer' | null>(null);

  const leavePages = async () => {
    await navigate('/');
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: queryKeys.me() }),
      queryClient.invalidateQueries({ queryKey: queryKeys.account.deletedTeams() }),
    ]);
  };

  return (
    <section aria-labelledby="danger-zone">
      <h2 id="danger-zone" className="pb-3 text-lg font-semibold tracking-tight">
        Danger zone
      </h2>
      <SettingsCard tone="danger">
        {team.isOwner ? (
          <>
            <SettingsRow
              title="Transfer ownership"
              description="Make another member the owner. You’ll stay in the team without owner rights."
            >
              <Button variant="outline" onClick={() => setConfirm('transfer')}>
                <CrownIcon aria-hidden="true" />
                Transfer
              </Button>
            </SettingsRow>
            <SettingsRow
              title="Delete this team"
              description="Moves the team, its projects, issues and tasks to Trash. You can restore it from your account settings for 30 days."
            >
              <Button variant="destructive" onClick={() => setConfirm('delete')}>
                <Trash2Icon aria-hidden="true" />
                Delete team
              </Button>
            </SettingsRow>
          </>
        ) : (
          <SettingsRow
            title="Leave team"
            description="You’ll lose access to its projects. You’ll need a new invite to come back."
          >
            <Button variant="destructive" onClick={() => setConfirm('leave')}>
              <LogOutIcon aria-hidden="true" />
              Leave team
            </Button>
          </SettingsRow>
        )}
      </SettingsCard>

      <ConfirmDialog
        open={confirm === 'delete'}
        onOpenChange={(open) => setConfirm(open ? 'delete' : null)}
        title={`Delete ${team.name}?`}
        description="The team and everything in it disappears for all members. You can restore it for 30 days; after that it’s gone for good."
        confirmLabel="Delete team"
        destructive
        typedConfirmation={team.slug}
        onConfirm={async () => {
          await deleteTeam.mutateAsync();
          await leavePages();
          toast.success(`Deleted ${team.name}`, {
            description: 'Restore it within 30 days from Settings → Account.',
            action: {
              label: 'Undo',
              onClick: () =>
                void restoreTeam(queryClient, team.id).then(
                  async (restored) => {
                    await navigate(`/t/${restored.slug}`);
                    toast.success(`Restored ${restored.name}`);
                  },
                  (error: unknown) => toast.error(errorMessage(error)),
                ),
            },
          });
        }}
      />
      <ConfirmDialog
        open={confirm === 'leave'}
        onOpenChange={(open) => setConfirm(open ? 'leave' : null)}
        title={`Leave ${team.name}?`}
        description="You’ll lose access to the team’s projects, and tasks assigned to you there are unassigned."
        confirmLabel="Leave team"
        destructive
        onConfirm={async () => {
          await leaveTeam.mutateAsync();
          await leavePages();
          toast.success(`You left ${team.name}`);
        }}
      />
      <TransferOwnershipDialog
        team={team}
        open={confirm === 'transfer'}
        onOpenChange={(open) => setConfirm(open ? 'transfer' : null)}
      />
    </section>
  );
}

function TransferOwnershipDialog({
  team,
  open,
  onOpenChange,
}: {
  team: MeTeam;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        {open ? <TransferForm team={team} onDone={() => onOpenChange(false)} /> : null}
      </DialogContent>
    </Dialog>
  );
}

function TransferForm({ team, onDone }: { team: MeTeam; onDone: () => void }) {
  const memberId = useId();
  const confirmId = useId();
  const members = useMembers(team.id);
  const transfer = useTransferOwnership(team.id);
  const [userId, setUserId] = useState('');
  const [typed, setTyped] = useState('');
  const candidates = (members.data?.items ?? []).filter((member) => !member.isOwner);
  const chosen = candidates.find((member) => member.user.id === userId);
  const ready = chosen !== undefined && typed.trim() === team.slug;

  return (
    <form
      className="grid gap-5"
      onSubmit={(event) => {
        event.preventDefault();
        if (!ready) return;
        transfer.mutate(userId, {
          onSuccess: () => {
            toast.success(`${chosen.user.name} now owns ${team.name}`);
            onDone();
          },
        });
      }}
    >
      <DialogHeader>
        <DialogTitle>Transfer ownership</DialogTitle>
        <DialogDescription>
          The new owner can delete the team and transfer it again. You’ll keep your roles but lose
          owner rights.
        </DialogDescription>
      </DialogHeader>
      {members.isPending ? (
        <Skeleton className="h-9 w-full" />
      ) : candidates.length === 0 ? (
        <p className="rounded-md border bg-muted/50 px-3 py-2 text-sm text-muted-foreground">
          There’s nobody to transfer to yet. Invite someone to the team first.
        </p>
      ) : (
        <div className="grid gap-4">
          <div className="grid gap-1.5">
            <Label htmlFor={memberId}>New owner</Label>
            <Select value={userId} onValueChange={setUserId}>
              <SelectTrigger id={memberId} className="w-full">
                <SelectValue placeholder="Choose a member" />
              </SelectTrigger>
              <SelectContent>
                {candidates.map((member) => (
                  <SelectItem key={member.user.id} value={member.user.id}>
                    <UserAvatar user={member.user} size="sm" />
                    {member.user.name}
                    <span className="text-muted-foreground">@{member.user.username}</span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor={confirmId} className="font-normal">
              Type <span className="font-mono font-semibold">{team.slug}</span> to confirm
            </Label>
            <Input
              id={confirmId}
              value={typed}
              onChange={(event) => setTyped(event.target.value)}
              autoComplete="off"
            />
          </div>
        </div>
      )}
      <FormError message={transfer.isError ? errorMessage(transfer.error) : null} />
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onDone} disabled={transfer.isPending}>
          Cancel
        </Button>
        <Button type="submit" variant="destructive" disabled={!ready || transfer.isPending}>
          {transfer.isPending ? <Spinner /> : null}
          Transfer ownership
        </Button>
      </DialogFooter>
    </form>
  );
}

function FormSkeleton() {
  return (
    <SettingsCard className="space-y-4 p-5">
      <div className="flex items-end gap-3">
        <Skeleton className="size-9 rounded-lg" />
        <Skeleton className="h-9 flex-1" />
      </div>
      <Skeleton className="h-9 w-full" />
      <Skeleton className="h-20 w-full" />
      <Skeleton className="h-14 w-full" />
    </SettingsCard>
  );
}
