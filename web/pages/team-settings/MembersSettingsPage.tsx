import { useQueryClient } from '@tanstack/react-query';
import {
  AtSignIcon,
  CrownIcon,
  LogOutIcon,
  MoreHorizontalIcon,
  PlusIcon,
  SearchIcon,
  UserMinusIcon,
  UserPlusIcon,
  UsersIcon,
  XIcon,
} from 'lucide-react';
import { useState } from 'react';
import { useNavigate } from 'react-router';
import { toast } from 'sonner';
import type { MeTeam } from '@shared/schemas/core';
import type { Member, Role } from '@shared/schemas/teams';
import { AgentBadge } from '@web/components/common/AgentBadge';
import { Chip } from '@web/components/common/Chip';
import { ConfirmDialog } from '@web/components/common/ConfirmDialog';
import { EmptyState } from '@web/components/common/EmptyState';
import { ErrorState } from '@web/components/common/ErrorState';
import { RelativeTime } from '@web/components/common/RelativeTime';
import { UserAvatar } from '@web/components/common/UserAvatar';
import { Badge } from '@web/components/ui/badge';
import { Button } from '@web/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@web/components/ui/dropdown-menu';
import { Input } from '@web/components/ui/input';
import { Skeleton } from '@web/components/ui/skeleton';
import { agentOwnerLabel, isAgentUser } from '@web/lib/agentMembers';
import { useReadableTextColor } from '@web/lib/colors';
import { pluralize } from '@web/lib/format';
import { queryKeys } from '@web/lib/queryKeys';
import { useDocumentTitle } from '@web/lib/title';
import {
  memberPermissions,
  moderationRefusal,
  roleAssignRefusal,
  type Viewer,
} from '@web/pages/teams/access';
import {
  useLeaveTeam,
  useMembers,
  useRemoveMember,
  useRoles,
  useSetMemberRole,
} from '@web/pages/teams/api';
import { copyText } from '@web/pages/teams/clipboard';
import { InviteDialog } from '@web/pages/teams/InviteDialog';
import { useSettingsTeam, useViewer } from './context';
import { MemberRolesPicker } from './RolePickers';
import { SettingsHeader } from './SettingsSection';

/**
 * Members: everyone in the team with their roles, people and their agent members alike; grant and
 * revoke roles and remove members.
 */
export default function MembersSettingsPage() {
  const team = useSettingsTeam();
  const viewer = useViewer(team);
  const members = useMembers(team.id);
  const roles = useRoles(team.id);
  const [query, setQuery] = useState('');
  const [inviteOpen, setInviteOpen] = useState(false);
  useDocumentTitle(['Members', team.name]);
  const canInvite = team.permissions.includes('CREATE_INVITES');

  const q = query.trim().toLowerCase();
  const filtered = (members.data?.items ?? []).filter(
    (member) =>
      !q ||
      member.user.name.toLowerCase().includes(q) ||
      member.user.username.includes(q) ||
      member.roles.some((role) => role.name.toLowerCase().includes(q)),
  );

  return (
    <div>
      <SettingsHeader
        title="Members"
        description={
          members.data
            ? `${pluralize(members.data.items.length, 'member')}. Members’ names show in the color of their highest colored role.`
            : 'Everyone in the team and their roles.'
        }
        actions={
          canInvite ? (
            <Button size="sm" onClick={() => setInviteOpen(true)}>
              <UserPlusIcon aria-hidden="true" />
              Invite people
            </Button>
          ) : null
        }
      />
      <div className="relative mb-3 max-w-sm">
        <SearchIcon
          className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
          aria-hidden="true"
        />
        <Input
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search by name, username or role"
          aria-label="Search members"
          className="pl-8"
        />
      </div>

      {members.isPending || roles.isPending ? (
        <MembersSkeleton />
      ) : members.isError || roles.isError ? (
        <ErrorState
          title="Couldn’t load members"
          error={members.error ?? roles.error}
          onRetry={() => {
            void members.refetch();
            void roles.refetch();
          }}
        />
      ) : filtered.length === 0 ? (
        <EmptyState
          icon={UsersIcon}
          title={q ? 'No members match' : 'No members'}
          description={q ? 'Try another name, username or role.' : undefined}
          action={
            q ? (
              <Button variant="outline" size="sm" onClick={() => setQuery('')}>
                Clear search
              </Button>
            ) : null
          }
        />
      ) : (
        <div className="rounded-lg border" role="table" aria-label="Members">
          <div
            role="row"
            className="hidden border-b bg-muted/40 px-4 py-2 text-xs font-medium text-muted-foreground md:grid md:grid-cols-[minmax(0,1.2fr)_minmax(0,1.6fr)_6.5rem_2rem] md:gap-4"
          >
            <span role="columnheader">Member</span>
            <span role="columnheader">Roles</span>
            <span role="columnheader">Joined</span>
            <span role="columnheader">
              <span className="sr-only">Actions</span>
            </span>
          </div>
          <div role="rowgroup" className="divide-y">
            {filtered.map((member) => (
              <MemberRow
                key={member.user.id}
                team={team}
                viewer={viewer}
                member={member}
                roles={roles.data.items}
              />
            ))}
          </div>
        </div>
      )}
      <InviteDialog
        teamId={team.id}
        teamName={team.name}
        open={inviteOpen}
        onOpenChange={setInviteOpen}
      />
    </div>
  );
}

interface MemberRowProps {
  team: MeTeam;
  viewer: Viewer;
  member: Member;
  roles: readonly Role[];
}

function MemberRow({ team, viewer, member, roles }: MemberRowProps) {
  const nameColor = useReadableTextColor(member.color);
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const setRole = useSetMemberRole(team.id);
  const removeMember = useRemoveMember(team.id);
  const leaveTeam = useLeaveTeam(team.id);
  const [confirm, setConfirm] = useState<'remove' | 'leave' | null>(null);
  const isSelf = member.user.id === viewer.userId;
  const agent = isAgentUser(member.user);
  const target = memberPermissions(member, roles);
  const subject = { ...target, userId: member.user.id };
  const assignable = roles.filter((role) => !role.isEveryone);
  const roleById = new Map(roles.map((role) => [role.id, role]));
  const canRemove = !isSelf && moderationRefusal(viewer, target) === null;
  const canPickRoles = assignable.some((role) => roleAssignRefusal(viewer, role, subject) === null);

  const toggle = (role: Role, assigned: boolean) =>
    setRole.mutate(
      { userId: member.user.id, role, assigned },
      {
        onSuccess: () =>
          toast.success(
            assigned
              ? `Gave ${member.user.name} the ${role.name} role`
              : `Removed ${role.name} from ${member.user.name}`,
          ),
      },
    );

  return (
    <div
      role="row"
      className="grid grid-cols-[minmax(0,1fr)_2rem] items-start gap-x-3 gap-y-2 px-4 py-3 md:grid-cols-[minmax(0,1.2fr)_minmax(0,1.6fr)_6.5rem_2rem] md:items-center md:gap-4"
    >
      <div role="cell" className="flex min-w-0 items-center gap-3">
        <UserAvatar user={member.user} size="lg" />
        <div className="min-w-0">
          <p className="flex min-w-0 items-center gap-1.5">
            <span className="truncate text-sm font-medium" style={nameColor}>
              {member.user.name}
            </span>
            {agent ? <AgentBadge /> : null}
            {member.isOwner ? (
              <CrownIcon className="size-3.5 shrink-0 text-amber-500" aria-label="Owner" />
            ) : null}
            {isSelf ? (
              <Badge variant="secondary" className="shrink-0">
                You
              </Badge>
            ) : null}
          </p>
          <p className="truncate text-xs text-muted-foreground">
            @{member.user.username}
            {agent ? ` · ${agentOwnerLabel(member.user)}` : null}
            <span className="md:hidden">
              {' · joined '}
              <RelativeTime value={member.joinedAt} />
            </span>
          </p>
        </div>
      </div>

      <div
        role="cell"
        className="col-start-1 row-start-2 flex min-w-0 flex-wrap items-center gap-1.5 md:col-start-auto md:row-start-auto"
      >
        {member.roles.map((role) => {
          const full = roleById.get(role.id);
          const refusal = full ? roleAssignRefusal(viewer, full, subject) : 'Unknown role';
          return (
            <span key={role.id} className="inline-flex items-center">
              <Chip color={role.color} title={`Role: ${role.name}`} className="pr-1">
                <span className="inline-flex items-center gap-1">
                  {role.name}
                  {refusal === null && full ? (
                    <button
                      type="button"
                      onClick={() => toggle(full, false)}
                      className="-mr-0.5 rounded-full p-0.5 text-muted-foreground outline-none hover:bg-foreground/10 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
                      aria-label={`Remove ${role.name} from ${member.user.name}`}
                    >
                      <XIcon className="size-3" aria-hidden="true" />
                    </button>
                  ) : null}
                </span>
              </Chip>
            </span>
          );
        })}
        {canPickRoles ? (
          <MemberRolesPicker
            roles={assignable}
            member={member}
            target={target}
            viewer={viewer}
            onToggle={toggle}
          >
            <Button
              variant="outline"
              size="xs"
              className="h-5 rounded-full px-1.5 text-muted-foreground"
              aria-label={`Edit roles of ${member.user.name}`}
            >
              <PlusIcon aria-hidden="true" />
              {member.roles.length === 0 ? 'Add role' : null}
            </Button>
          </MemberRolesPicker>
        ) : member.roles.length === 0 ? (
          <span className="text-xs text-muted-foreground">No roles</span>
        ) : null}
      </div>

      <div role="cell" className="hidden text-sm md:block">
        <RelativeTime value={member.joinedAt} />
      </div>

      <div
        role="cell"
        className="col-start-2 row-start-1 flex justify-end md:col-start-auto md:row-start-auto"
      >
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon-sm" aria-label={`Actions for ${member.user.name}`}>
              <MoreHorizontalIcon aria-hidden="true" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem
              onSelect={() => void copyText(`@${member.user.username}`, 'Username')}
            >
              <AtSignIcon aria-hidden="true" />
              Copy username
            </DropdownMenuItem>
            {canRemove ? (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem variant="destructive" onSelect={() => setConfirm('remove')}>
                  <UserMinusIcon aria-hidden="true" />
                  Remove from team
                </DropdownMenuItem>
              </>
            ) : null}
            {isSelf && !member.isOwner ? (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem variant="destructive" onSelect={() => setConfirm('leave')}>
                  <LogOutIcon aria-hidden="true" />
                  Leave team
                </DropdownMenuItem>
              </>
            ) : null}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <ConfirmDialog
        open={confirm === 'remove'}
        onOpenChange={(open) => setConfirm(open ? 'remove' : null)}
        title={`Remove ${member.user.name}?`}
        description={
          agent
            ? `${member.user.name} loses access to ${team.name} and is unassigned from its tasks. It comes back only if ${member.user.agentOwner?.name ?? 'its owner'} rejoins the team.`
            : `${member.user.name} and their agent lose access to ${team.name} and are unassigned from its tasks. They can come back with a new invite.`
        }
        confirmLabel="Remove member"
        destructive
        onConfirm={async () => {
          await removeMember.mutateAsync(member.user.id);
          toast.success(`Removed ${member.user.name} from ${team.name}`);
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
          await navigate('/');
          await queryClient.invalidateQueries({ queryKey: queryKeys.me() });
          toast.success(`You left ${team.name}`);
        }}
      />
    </div>
  );
}

function MembersSkeleton() {
  return (
    <div className="divide-y rounded-lg border" role="status" aria-label="Loading members">
      {[0, 1, 2, 3].map((index) => (
        <div key={index} className="flex items-center gap-3 px-4 py-3">
          <Skeleton className="size-8 rounded-full" />
          <div className="flex-1 space-y-1.5">
            <Skeleton className="h-4 w-32" />
            <Skeleton className="h-3 w-20" />
          </div>
          <Skeleton className="hidden h-5 w-24 rounded-full md:block" />
        </div>
      ))}
    </div>
  );
}
