import { SettingsIcon, UserPlusIcon, UsersIcon } from 'lucide-react';
import { useId, useMemo, useState } from 'react';
import { Link } from 'react-router';
import type { MeTeam } from '@shared/schemas/core';
import type { Member } from '@shared/schemas/teams';
import { EmptyState } from '@web/components/common/EmptyState';
import { ErrorState } from '@web/components/common/ErrorState';
import { NotFound } from '@web/components/common/NotFound';
import { PageContainer } from '@web/components/common/PageContainer';
import { RoleChip } from '@web/components/common/RoleChip';
import { UserAvatar } from '@web/components/common/UserAvatar';
import { UserName } from '@web/components/common/UserName';
import { Badge } from '@web/components/ui/badge';
import { Button } from '@web/components/ui/button';
import { Skeleton } from '@web/components/ui/skeleton';
import { agentOwnerLabel, isAgentUser } from '@web/lib/agentMembers';
import { pluralize } from '@web/lib/format';
import { useTeamAccess } from '@web/lib/permissions';
import { useRouteContext } from '@web/lib/routeContext';
import { useDocumentTitle } from '@web/lib/title';
import { cn } from '@web/lib/utils';
import { useMembers, useTeamPresence } from './api';
import { InviteDialog } from './InviteDialog';
import { memberSections, type MemberSection } from './memberSections';
import { TeamIcon } from './TeamIcon';
import { TeamTabs } from './TeamTabs';

/** Roles shown on a row before "+n". */
const ROLE_CHIPS = 2;

/**
 * `/t/:team/members`: the team's members like Discord's member list (design §7): a section per
 * hoisted role (highest first), then Members and Agents, each split into Online and Offline, with
 * presence dots that follow live `presence.changed` events.
 */
export default function TeamMembersPage() {
  const { team, isLoading } = useRouteContext();
  if (isLoading) {
    return (
      <PageContainer>
        <MembersSkeleton />
      </PageContainer>
    );
  }
  if (!team) return <NotFound what="Team" />;
  return <TeamMembers team={team} />;
}

function TeamMembers({ team }: { team: MeTeam }) {
  const access = useTeamAccess(team.id);
  const members = useMembers(team.id);
  const presence = useTeamPresence(team.id);
  const [inviteOpen, setInviteOpen] = useState(false);
  const canInvite = access.has('CREATE_INVITES');
  useDocumentTitle(['Members', team.name]);

  const online = useMemo(() => new Set(presence.data?.online ?? []), [presence.data]);
  const runners = useMemo(() => {
    const byAgent = new Map<string, Array<{ machineName: string; running: number }>>();
    for (const runner of presence.data?.runners ?? []) {
      byAgent.set(runner.agentUserId, [...(byAgent.get(runner.agentUserId) ?? []), runner]);
    }
    return byAgent;
  }, [presence.data]);
  const sections = useMemo(
    () => (members.data ? memberSections(members.data.items, online) : []),
    [members.data, online],
  );
  const total = members.data?.items.length ?? 0;
  const onlineCount = sections.reduce((sum, section) => sum + section.online.length, 0);

  return (
    <PageContainer>
      <header className="flex flex-col gap-4 border-b">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex min-w-0 items-center gap-3">
            <TeamIcon icon={team.icon} name={team.name} color={team.color} size="lg" />
            <div className="min-w-0">
              <h1 className="truncate text-xl font-semibold tracking-tight">{team.name}</h1>
              <p className="text-sm text-muted-foreground" aria-live="polite">
                {members.data
                  ? `${pluralize(total, 'member')} · ${onlineCount} online`
                  : 'Members of the team'}
              </p>
            </div>
          </div>
          <div className="flex shrink-0 flex-wrap gap-2">
            {canInvite ? (
              <Button variant="outline" size="sm" onClick={() => setInviteOpen(true)}>
                <UserPlusIcon aria-hidden="true" />
                Invite people
              </Button>
            ) : null}
            {access.has('MANAGE_MEMBERS') || access.has('MANAGE_ROLES') ? (
              <Button variant="outline" size="sm" asChild>
                <Link to={`/t/${team.slug}/settings/members`}>
                  <SettingsIcon aria-hidden="true" />
                  Manage
                </Link>
              </Button>
            ) : null}
          </div>
        </div>
        <TeamTabs teamSlug={team.slug} active="members" />
      </header>

      <div className="pt-6">
        {members.isPending ? (
          <MembersSkeleton />
        ) : members.isError ? (
          <ErrorState
            title="Couldn’t load members"
            error={members.error}
            onRetry={() => void members.refetch()}
          />
        ) : total <= 1 ? (
          <EmptyState
            icon={UsersIcon}
            title="Just you so far"
            description={
              canInvite
                ? 'Invite people to work with you; their agents join with them.'
                : 'Members appear here once someone with the Create invites permission invites them.'
            }
            action={
              canInvite ? (
                <Button onClick={() => setInviteOpen(true)}>
                  <UserPlusIcon aria-hidden="true" />
                  Invite people
                </Button>
              ) : null
            }
          />
        ) : (
          <div className="grid gap-8">
            {presence.isError ? (
              <p className="text-xs text-muted-foreground" role="status">
                Couldn’t load who is online; everyone is listed as offline.
              </p>
            ) : null}
            {sections.map((section) => (
              <MemberSectionList key={section.id} section={section} runners={runners} />
            ))}
          </div>
        )}
      </div>

      <InviteDialog
        teamId={team.id}
        teamName={team.name}
        open={inviteOpen}
        onOpenChange={setInviteOpen}
      />
    </PageContainer>
  );
}

type RunnersByAgent = ReadonlyMap<string, ReadonlyArray<{ machineName: string; running: number }>>;

function MemberSectionList({
  section,
  runners,
}: {
  section: MemberSection;
  runners: RunnersByAgent;
}) {
  const headingId = useId();
  const total = section.online.length + section.offline.length;
  return (
    <section aria-labelledby={headingId} className="space-y-3">
      <h2
        id={headingId}
        className="flex items-center gap-2 text-sm font-semibold"
        data-member-section={section.id}
      >
        {section.color ? (
          <span
            aria-hidden="true"
            className="size-2.5 rounded-full"
            style={{ backgroundColor: section.color }}
          />
        ) : null}
        {section.title}
        <span className="font-normal text-muted-foreground">— {total}</span>
      </h2>
      <div className="grid gap-4 sm:grid-cols-2">
        <PresenceGroup label="Online" members={section.online} online runners={runners} />
        <PresenceGroup label="Offline" members={section.offline} online={false} runners={runners} />
      </div>
    </section>
  );
}

function PresenceGroup({
  label,
  members,
  online,
  runners,
}: {
  label: string;
  members: Member[];
  online: boolean;
  runners: RunnersByAgent;
}) {
  const headingId = useId();
  if (members.length === 0) return null;
  return (
    <div className="min-w-0 rounded-lg border">
      <h3
        id={headingId}
        className="border-b px-3 py-2 text-xs font-medium tracking-wide text-muted-foreground uppercase"
      >
        {label} — {members.length}
      </h3>
      <ul aria-labelledby={headingId} className="divide-y">
        {members.map((member) => (
          <MemberRow
            key={member.user.id}
            member={member}
            online={online}
            runners={runners.get(member.user.id) ?? []}
          />
        ))}
      </ul>
    </div>
  );
}

function MemberRow({
  member,
  online,
  runners,
}: {
  member: Member;
  online: boolean;
  /** Its desktop apps running now ("MSI — 1 job"), for agents. */
  runners: ReadonlyArray<{ machineName: string; running: number }>;
}) {
  const agent = isAgentUser(member.user);
  const shown = member.roles.slice(0, ROLE_CHIPS);
  const more = member.roles.length - shown.length;
  return (
    <li
      className={cn('flex items-center gap-3 px-3 py-2', !online && 'text-muted-foreground')}
      data-presence={online ? 'online' : 'offline'}
    >
      <span className="relative shrink-0">
        <UserAvatar user={member.user} size="lg" className={cn(!online && 'opacity-60')} />
        <PresenceDot online={online} agent={agent} />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-1.5">
          <UserName
            user={member.user}
            color={member.color}
            className={cn('min-w-0 text-sm', !online && 'opacity-80')}
          />
          {member.isOwner ? (
            <Badge variant="outline" className="shrink-0">
              Owner
            </Badge>
          ) : null}
          <span className="sr-only">, {online ? 'online' : 'offline'}</span>
        </div>
        <p className="truncate text-xs text-muted-foreground">
          {agent
            ? agentOwnerLabel(member.user)
            : member.user.username
              ? `@${member.user.username}`
              : ''}
        </p>
        {runners.map((runner) => (
          <p key={runner.machineName} className="truncate text-xs text-muted-foreground">
            {runner.machineName} — {pluralize(runner.running, 'job')}
          </p>
        ))}
      </div>
      {shown.length > 0 ? (
        <div className="hidden shrink-0 items-center gap-1 md:flex">
          {shown.map((role) => (
            <RoleChip key={role.id} role={role} />
          ))}
          {more > 0 ? <span className="text-xs text-muted-foreground">+{more}</span> : null}
        </div>
      ) : null}
    </li>
  );
}

/**
 * A filled green dot when online, a hollow ring when offline: the shape differs, so color is not
 * the only signal (and the row says "online"/"offline" to screen readers). Agents' avatars carry
 * their owner's picture bottom right, so their dot sits top right.
 */
function PresenceDot({ online, agent }: { online: boolean; agent: boolean }) {
  return (
    <span
      aria-hidden="true"
      data-presence-dot={online ? 'online' : 'offline'}
      className={cn(
        'absolute -right-0.5 size-3 rounded-full ring-2 ring-background',
        agent ? '-top-0.5' : '-bottom-0.5',
        online ? 'bg-emerald-500' : 'border-2 border-muted-foreground/60 bg-background',
      )}
    />
  );
}

function MembersSkeleton() {
  return (
    <div className="grid gap-6" role="status" aria-label="Loading members">
      {[0, 1].map((section) => (
        <div key={section} className="space-y-3">
          <Skeleton className="h-4 w-32" />
          <div className="space-y-3 rounded-lg border p-3">
            {[0, 1, 2].map((row) => (
              <div key={row} className="flex items-center gap-3">
                <Skeleton className="size-8 rounded-full" />
                <Skeleton className="h-4 flex-1" />
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
