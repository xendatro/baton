import { useQueryClient } from '@tanstack/react-query';
import { ExternalLinkIcon, Trash2Icon } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router';
import { toast } from 'sonner';
import type { MeResponse } from '@shared/schemas/core';
import { ownedTeamsConflictSchema, type OwnedTeamsConflict } from '@shared/schemas/account';
import { FormError, FormField } from '@web/components/auth/FormField';
import { PasswordInput } from '@web/components/auth/PasswordInput';
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
import { Input } from '@web/components/ui/input';
import { errorMessage, isApiError } from '@web/lib/api';
import { queryKeys } from '@web/lib/queryKeys';
import { deleteAccountRequest, useDeletedTeams } from './queries';
import { SettingsCard } from './SettingsCard';

type OwnedTeam = OwnedTeamsConflict['teams'][number];

/** Teams blocking deletion: owned live teams (from `me`) and owned teams in Trash. */
function useOwnedTeams(me: MeResponse): OwnedTeam[] {
  const deleted = useDeletedTeams().data?.items ?? [];
  return [
    ...me.teams
      .filter((team) => team.isOwner)
      .map((team) => ({ id: team.id, name: team.name, slug: team.slug, deleted: false })),
    ...deleted.map((team) => ({ id: team.id, name: team.name, slug: team.slug, deleted: true })),
  ];
}

function OwnedTeamsNotice({ teams, onNavigate }: { teams: OwnedTeam[]; onNavigate: () => void }) {
  return (
    <div className="grid gap-3 text-sm">
      <p>
        You own {teams.length === 1 ? 'a team' : `${teams.length} teams`}. Transfer ownership to
        another member or delete {teams.length === 1 ? 'it' : 'them'} first. Deleted teams count
        until they are purged, 30 days after deletion.
      </p>
      <ul className="grid gap-1.5">
        {teams.map((team) => (
          <li
            key={team.id}
            className="flex items-center justify-between gap-3 rounded-md border px-3 py-2"
          >
            <span className="min-w-0 truncate font-medium">
              {team.name}
              {team.deleted ? (
                <span className="ml-2 text-xs font-normal text-muted-foreground">in Trash</span>
              ) : null}
            </span>
            {team.deleted ? null : (
              <Link
                to={`/t/${team.slug}/settings/general`}
                onClick={onNavigate}
                className="inline-flex shrink-0 items-center gap-1 text-xs text-primary hover:underline"
              >
                Team settings
                <ExternalLinkIcon className="size-3" aria-hidden="true" />
              </Link>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

function DeleteAccountDialog({
  me,
  hasPassword,
  open,
  onOpenChange,
}: {
  me: MeResponse;
  hasPassword: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const owned = useOwnedTeams(me);
  const username = me.user.username ?? '';
  const [password, setPassword] = useState('');
  const [confirmUsername, setConfirmUsername] = useState('');
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [blockedBy, setBlockedBy] = useState<OwnedTeam[] | null>(null);
  const [pending, setPending] = useState(false);
  const blocking = blockedBy ?? owned;
  const ready = hasPassword
    ? password.length > 0
    : confirmUsername.trim().toLowerCase() === username.toLowerCase();

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!ready || pending || blocking.length > 0) return;
    setPending(true);
    setFieldError(null);
    setFormError(null);
    try {
      await deleteAccountRequest(hasPassword ? { password } : { confirmUsername });
      queryClient.clear();
      queryClient.setQueryData(queryKeys.session(), null);
      await navigate('/login', { replace: true });
      toast.success('Your account was deleted. Thanks for using Baton.');
    } catch (cause) {
      const conflict =
        isApiError(cause) && cause.code === 'conflict'
          ? ownedTeamsConflictSchema.safeParse(cause.details)
          : null;
      if (conflict?.success) {
        setBlockedBy(conflict.data.teams);
      } else if (isApiError(cause) && Object.keys(cause.fieldErrors).length > 0) {
        setFieldError(Object.values(cause.fieldErrors)[0] ?? errorMessage(cause));
      } else {
        setFormError(errorMessage(cause));
      }
      setPending(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !pending && onOpenChange(next)}>
      <DialogContent>
        <form className="grid gap-4" onSubmit={(event) => void submit(event)} noValidate>
          <DialogHeader>
            <DialogTitle>Delete your account?</DialogTitle>
            <DialogDescription>
              This can’t be undone. Your sessions, API keys, team memberships and sign-in methods
              are removed right away.
            </DialogDescription>
          </DialogHeader>
          {blocking.length > 0 ? (
            <OwnedTeamsNotice teams={blocking} onNavigate={() => onOpenChange(false)} />
          ) : (
            <>
              <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
                <li>Issues, tasks and replies you wrote stay, shown as by a “Deleted user”.</li>
                <li>
                  <span className="font-medium text-foreground">@{username}</span> becomes free for
                  anyone to take.
                </li>
              </ul>
              {hasPassword ? (
                <FormField label="Your password" error={fieldError}>
                  {(field) => (
                    <PasswordInput
                      {...field}
                      value={password}
                      onChange={(event) => {
                        setPassword(event.target.value);
                        setFieldError(null);
                      }}
                      autoComplete="current-password"
                      autoFocus
                    />
                  )}
                </FormField>
              ) : (
                <FormField label={`Type your username, ${username}, to confirm`} error={fieldError}>
                  {(field) => (
                    <Input
                      {...field}
                      value={confirmUsername}
                      onChange={(event) => {
                        setConfirmUsername(event.target.value);
                        setFieldError(null);
                      }}
                      autoComplete="off"
                      autoCapitalize="none"
                      spellCheck={false}
                      autoFocus
                    />
                  )}
                </FormField>
              )}
              <FormError message={formError} />
            </>
          )}
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={pending}
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            {blocking.length > 0 ? null : (
              <Button type="submit" variant="destructive" disabled={!ready || pending}>
                {pending ? <Spinner /> : null}
                Delete my account
              </Button>
            )}
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** Danger zone: delete the account (blocked while the user owns a team). */
export function DeleteAccountCard({ me, hasPassword }: { me: MeResponse; hasPassword: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <SettingsCard
        tone="danger"
        title="Delete account"
        description="Permanently delete your Baton account. Teams you own must be transferred or deleted first."
        action={
          <Button type="button" variant="destructive" size="sm" onClick={() => setOpen(true)}>
            <Trash2Icon aria-hidden="true" />
            Delete account
          </Button>
        }
      />
      {open ? (
        <DeleteAccountDialog me={me} hasPassword={hasPassword} open onOpenChange={setOpen} />
      ) : null}
    </>
  );
}
