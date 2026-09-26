import { CopyIcon, LinkIcon, PlusIcon, Trash2Icon } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import type { MeTeam } from '@shared/schemas/core';
import type { Invite } from '@shared/schemas/teams';
import { ConfirmDialog } from '@web/components/common/ConfirmDialog';
import { EmptyState } from '@web/components/common/EmptyState';
import { ErrorState } from '@web/components/common/ErrorState';
import { RelativeTime } from '@web/components/common/RelativeTime';
import { UserName } from '@web/components/common/UserName';
import { useNow } from '@web/components/common/useNow';
import { Badge } from '@web/components/ui/badge';
import { Button } from '@web/components/ui/button';
import { Skeleton } from '@web/components/ui/skeleton';
import { formatDateTime } from '@web/lib/format';
import { useDocumentTitle } from '@web/lib/title';
import { cn } from '@web/lib/utils';
import { useInvites, useRevokeInvite } from '@web/pages/teams/api';
import { copyText, inviteLink } from '@web/pages/teams/clipboard';
import { InviteDialog } from '@web/pages/teams/InviteDialog';
import { useSettingsTeam, useViewer } from './context';
import { NoAccess, SettingsHeader } from './SettingsSection';

/** Invites: create links, see uses, expiry and creators, copy and revoke. */
export default function InvitesSettingsPage() {
  const team = useSettingsTeam();
  const canCreate = team.permissions.includes('CREATE_INVITES');
  const seeAll = team.permissions.includes('MANAGE_INVITES');
  useDocumentTitle(['Invites', team.name]);
  if (!canCreate && !seeAll) return <NoAccess what="invites" permission="Create invites" />;
  return <Invites team={team} canCreate={canCreate} seeAll={seeAll} />;
}

function Invites({
  team,
  canCreate,
  seeAll,
}: {
  team: MeTeam;
  canCreate: boolean;
  seeAll: boolean;
}) {
  const invites = useInvites(team.id);
  const [createOpen, setCreateOpen] = useState(false);

  return (
    <div>
      <SettingsHeader
        title="Invites"
        description={
          seeAll
            ? 'Every active invite link of the team. Anyone with a Baton account can join with a link while it’s valid.'
            : 'Your invite links. Anyone with a Baton account can join with a link while it’s valid.'
        }
        actions={
          canCreate ? (
            <Button size="sm" onClick={() => setCreateOpen(true)}>
              <PlusIcon aria-hidden="true" />
              Create invite link
            </Button>
          ) : null
        }
      />
      {invites.isPending ? (
        <InvitesSkeleton />
      ) : invites.isError ? (
        <ErrorState
          title="Couldn’t load invites"
          error={invites.error}
          onRetry={() => void invites.refetch()}
        />
      ) : invites.data.items.length === 0 ? (
        <EmptyState
          icon={LinkIcon}
          title="No invite links"
          description="Create a link and share it with the people you want in the team."
          action={
            canCreate ? (
              <Button onClick={() => setCreateOpen(true)}>
                <PlusIcon aria-hidden="true" />
                Create invite link
              </Button>
            ) : null
          }
        />
      ) : (
        <div className="rounded-lg border" role="table" aria-label="Invite links">
          <div
            role="row"
            className="hidden border-b bg-muted/40 px-4 py-2 text-xs font-medium text-muted-foreground md:grid md:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)_5rem_7.5rem_4.5rem] md:gap-4"
          >
            <span role="columnheader">Link</span>
            <span role="columnheader">Created by</span>
            <span role="columnheader">Uses</span>
            <span role="columnheader">Expires</span>
            <span role="columnheader">
              <span className="sr-only">Actions</span>
            </span>
          </div>
          <div role="rowgroup" className="divide-y">
            {invites.data.items.map((invite) => (
              <InviteRow key={invite.id} team={team} invite={invite} canRevokeAny={seeAll} />
            ))}
          </div>
        </div>
      )}
      <InviteDialog
        teamId={team.id}
        teamName={team.name}
        open={createOpen}
        onOpenChange={setCreateOpen}
      />
    </div>
  );
}

const STATUS_LABELS: Record<Invite['status'], string> = {
  active: 'Active',
  expired: 'Expired',
  used_up: 'Used up',
  inactive: 'Inactive',
};

/** "in 7d", "Never", "Expired"; in a sentence (`inline`): "expires in 7d", "never expires". */
function ExpiryLabel({ invite, inline = false }: { invite: Invite; inline?: boolean }) {
  const now = useNow();
  if (!invite.expiresAt) {
    return <span className="text-muted-foreground">{inline ? 'never expires' : 'Never'}</span>;
  }
  const expires = new Date(invite.expiresAt).getTime();
  if (expires <= now) {
    return (
      <span className="text-muted-foreground" title={formatDateTime(invite.expiresAt)}>
        {inline ? 'expired' : 'Expired'}
      </span>
    );
  }
  const minutes = Math.round((expires - now) / 60_000);
  const text =
    minutes < 60
      ? `in ${Math.max(1, minutes)}m`
      : minutes < 48 * 60
        ? `in ${Math.round(minutes / 60)}h`
        : `in ${Math.round(minutes / (24 * 60))}d`;
  return <span title={formatDateTime(invite.expiresAt)}>{inline ? `expires ${text}` : text}</span>;
}

function InviteRow({
  team,
  invite,
  canRevokeAny,
}: {
  team: MeTeam;
  invite: Invite;
  canRevokeAny: boolean;
}) {
  const viewer = useViewer(team);
  const revoke = useRevokeInvite(team.id);
  const [confirm, setConfirm] = useState(false);
  const canRevoke = canRevokeAny || invite.createdBy?.id === viewer.userId;
  const active = invite.status === 'active';
  const link = inviteLink(invite);

  return (
    <div
      role="row"
      className={cn(
        'grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1.5 px-4 py-3 md:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)_5rem_7.5rem_4.5rem] md:gap-4',
        !active && 'bg-muted/30',
      )}
    >
      <div role="cell" className="flex min-w-0 items-center gap-2">
        <code
          className={cn(
            'truncate rounded bg-muted px-1.5 py-0.5 font-mono text-xs',
            !active && 'text-muted-foreground line-through',
          )}
          title={link}
        >
          {invite.code}
        </code>
        {!active ? (
          <Badge
            variant="outline"
            className="shrink-0"
            title={
              invite.status === 'inactive'
                ? 'Its creator can no longer create invites, so the link no longer works'
                : undefined
            }
          >
            {STATUS_LABELS[invite.status]}
          </Badge>
        ) : null}
      </div>
      <div
        role="cell"
        className="col-start-1 row-start-2 flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground md:col-start-auto md:row-start-auto md:text-sm md:text-foreground"
      >
        <UserName user={invite.createdBy} avatar="sm" hovercard={false} className="min-w-0" />
        <span className="md:hidden">
          · <RelativeTime value={invite.createdAt} />
        </span>
      </div>
      <div
        role="cell"
        className="col-start-1 row-start-3 text-xs text-muted-foreground md:col-start-auto md:row-start-auto md:text-sm md:text-foreground"
      >
        <span className="md:hidden">Uses: </span>
        {invite.uses}
        {invite.maxUses !== null ? ` / ${invite.maxUses}` : ''}
        <span className="md:hidden">
          {' · '}
          <ExpiryLabel invite={invite} inline />
        </span>
      </div>
      <div role="cell" className="hidden text-sm md:block">
        <ExpiryLabel invite={invite} />
      </div>
      <div
        role="cell"
        className="col-start-2 row-span-3 row-start-1 flex items-center justify-end gap-1 md:col-start-auto md:row-span-1 md:row-start-auto"
      >
        {active ? (
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={`Copy invite link ${invite.code}`}
            title="Copy link"
            onClick={() => void copyText(link)}
          >
            <CopyIcon aria-hidden="true" />
          </Button>
        ) : null}
        {canRevoke ? (
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={active ? `Revoke invite ${invite.code}` : `Remove invite ${invite.code}`}
            title={active ? 'Revoke' : 'Remove'}
            onClick={() => setConfirm(true)}
            className="text-muted-foreground hover:text-destructive"
          >
            <Trash2Icon aria-hidden="true" />
          </Button>
        ) : null}
      </div>
      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        title={active ? 'Revoke this invite link?' : 'Remove this invite link?'}
        description={
          active
            ? 'Nobody else can join with it. People who already joined stay in the team.'
            : 'It no longer works; this removes it from the list.'
        }
        confirmLabel={active ? 'Revoke link' : 'Remove'}
        destructive
        onConfirm={async () => {
          await revoke.mutateAsync(invite.id);
          toast.success(active ? 'Invite link revoked' : 'Invite link removed');
        }}
      />
    </div>
  );
}

function InvitesSkeleton() {
  return (
    <div className="divide-y rounded-lg border" role="status" aria-label="Loading invites">
      {[0, 1, 2].map((index) => (
        <div key={index} className="flex items-center gap-4 px-4 py-3">
          <Skeleton className="h-5 w-28" />
          <Skeleton className="h-4 w-24" />
          <Skeleton className="ml-auto h-4 w-16" />
        </div>
      ))}
    </div>
  );
}
