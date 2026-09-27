import { useQueryClient } from '@tanstack/react-query';
import {
  CircleDotIcon,
  FolderKanbanIcon,
  ListTodoIcon,
  PlusIcon,
  SettingsIcon,
  UserPlusIcon,
  UsersIcon,
} from 'lucide-react';
import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import type { MeTeam } from '@shared/schemas/core';
import type { Member, TeamProjectCard } from '@shared/schemas/teams';
import { EmptyState } from '@web/components/common/EmptyState';
import { ErrorState } from '@web/components/common/ErrorState';
import { NotFound } from '@web/components/common/NotFound';
import { PageContainer } from '@web/components/common/PageContainer';
import { RoleChip } from '@web/components/common/RoleChip';
import { UserAvatar } from '@web/components/common/UserAvatar';
import { UserName } from '@web/components/common/UserName';
import { usePaletteCommands } from '@web/components/palette/registry';
import { Badge } from '@web/components/ui/badge';
import { Button } from '@web/components/ui/button';
import { Skeleton } from '@web/components/ui/skeleton';
import { pluralize } from '@web/lib/format';
import { useLiveEventListener } from '@web/lib/live';
import { useTeamAccess } from '@web/lib/permissions';
import { queryKeys } from '@web/lib/queryKeys';
import { useRouteContext } from '@web/lib/routeContext';
import { runShellAction, useShellActionAvailable } from '@web/lib/shellActions';
import { useDocumentTitle } from '@web/lib/title';
import { useMembers, useTeamOverview } from './api';
import { InviteDialog } from './InviteDialog';
import { TeamIcon } from './TeamIcon';
import { TeamTabs } from './TeamTabs';

/** Members shown in the preview before "View all". */
const MEMBER_PREVIEW = 8;

/** `/t/:team`: the team's header, its projects and a preview of its members. */
export default function TeamHomePage() {
  const { team, isLoading } = useRouteContext();
  if (isLoading) return <TeamHomeSkeleton />;
  if (!team) return <NotFound what="Team" />;
  return <TeamHome team={team} />;
}

function TeamHome({ team }: { team: MeTeam }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const access = useTeamAccess(team.id);
  const overview = useTeamOverview(team.id);
  const members = useMembers(team.id);
  const [inviteOpen, setInviteOpen] = useState(false);
  const projectCreateAvailable = useShellActionAvailable('project.create');
  const canCreateProject = projectCreateAvailable && access.has('MANAGE_PROJECTS');
  const canInvite = access.has('CREATE_INVITES');
  useDocumentTitle([team.name]);

  // Open task and issue counts change with every task or issue event of the team.
  useLiveEventListener((event) => {
    if (event.teamId !== team.id) return;
    if (event.type.startsWith('task.') || event.type.startsWith('issue.')) {
      void queryClient.invalidateQueries({ queryKey: queryKeys.teams.overview(team.id) });
    }
  });

  const newProject = () => runShellAction('project.create', { teamId: team.id });
  usePaletteCommands([
    {
      id: 'team.settings',
      label: `${team.name}: settings`,
      group: 'Team',
      icon: SettingsIcon,
      keywords: ['team settings', 'members', 'roles'],
      perform: () => void navigate(`/t/${team.slug}/settings`),
    },
    ...(canInvite
      ? [
          {
            id: 'team.invite',
            label: `Invite people to ${team.name}`,
            group: 'Team',
            icon: UserPlusIcon,
            keywords: ['invite link', 'join'],
            perform: () => setInviteOpen(true),
          },
        ]
      : []),
  ]);

  const detail = overview.data?.team;
  const description = detail?.description ?? '';
  const memberCount = members.data?.items.length ?? detail?.memberCount;

  return (
    <PageContainer>
      <header className="flex flex-col gap-4 border-b">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="flex min-w-0 items-start gap-4">
            <TeamIcon icon={team.icon} name={team.name} color={team.color} size="xl" />
            <div className="min-w-0 space-y-1 pt-1">
              <h1 className="truncate text-2xl font-semibold tracking-tight">{team.name}</h1>
              {overview.isPending ? (
                <Skeleton className="h-4 w-64 max-w-full" />
              ) : description ? (
                <p className="max-w-2xl text-sm whitespace-pre-line text-muted-foreground">
                  {description}
                </p>
              ) : null}
              <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                {memberCount !== undefined ? (
                  <span className="inline-flex items-center gap-1">
                    <UsersIcon className="size-3.5" aria-hidden="true" />
                    {pluralize(memberCount, 'member')}
                  </span>
                ) : null}
                <span className="inline-flex items-center gap-1">
                  <FolderKanbanIcon className="size-3.5" aria-hidden="true" />
                  {pluralize(team.projects.length, 'project')}
                </span>
                {team.isOwner ? <Badge variant="secondary">Owner</Badge> : null}
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
            <Button variant="outline" size="sm" asChild>
              <Link to={`/t/${team.slug}/settings`}>
                <SettingsIcon aria-hidden="true" />
                Settings
              </Link>
            </Button>
          </div>
        </div>
        <TeamTabs teamSlug={team.slug} active="overview" />
      </header>

      <div className="grid gap-8 pt-6 lg:grid-cols-[minmax(0,1fr)_18rem]">
        <section aria-labelledby="team-projects" className="min-w-0 space-y-3">
          <div className="flex items-center justify-between gap-2">
            <h2 id="team-projects" className="text-sm font-semibold">
              Projects
            </h2>
            {canCreateProject ? (
              <Button size="sm" onClick={newProject}>
                <PlusIcon aria-hidden="true" />
                New project
              </Button>
            ) : null}
          </div>
          {overview.isPending ? (
            <ProjectGridSkeleton />
          ) : overview.isError ? (
            <ErrorState
              title="Couldn’t load projects"
              error={overview.error}
              onRetry={() => void overview.refetch()}
            />
          ) : overview.data.projects.length === 0 ? (
            <EmptyState
              icon={FolderKanbanIcon}
              headingLevel={3}
              title="No projects yet"
              description={
                canCreateProject
                  ? 'Projects hold your issues and tasks. Create the first one to get started.'
                  : access.has('MANAGE_PROJECTS')
                    ? 'Projects hold your issues and tasks.'
                    : 'Projects hold issues and tasks. Someone with the Manage projects permission can create one.'
              }
              action={
                canCreateProject ? (
                  <Button onClick={newProject}>
                    <PlusIcon aria-hidden="true" />
                    New project
                  </Button>
                ) : null
              }
            />
          ) : (
            <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
              {overview.data.projects.map((project) => (
                <li key={project.id}>
                  <ProjectCard teamSlug={team.slug} project={project} />
                </li>
              ))}
            </ul>
          )}
        </section>

        <aside aria-labelledby="team-members" className="space-y-3">
          <div className="flex items-center justify-between gap-2">
            <h2 id="team-members" className="text-sm font-semibold">
              Members
            </h2>
            <Button variant="link" size="sm" className="h-auto px-0" asChild>
              <Link to={`/t/${team.slug}/members`}>View all</Link>
            </Button>
          </div>
          <MembersPreview
            members={members.data?.items}
            isPending={members.isPending}
            error={members.isError ? members.error : null}
            onRetry={() => void members.refetch()}
            teamSlug={team.slug}
            canInvite={canInvite}
            onInvite={() => setInviteOpen(true)}
          />
        </aside>
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

function ProjectCard({ teamSlug, project }: { teamSlug: string; project: TeamProjectCard }) {
  return (
    <Link
      to={`/t/${teamSlug}/p/${project.key}`}
      className="group flex h-full flex-col gap-3 rounded-lg border bg-card p-4 transition-colors outline-none hover:border-foreground/20 hover:bg-accent/40 focus-visible:ring-[3px] focus-visible:ring-ring/50"
    >
      <div className="flex min-w-0 items-center gap-3">
        <TeamIcon icon={project.icon} name={project.name} color={project.color} size="sm" />
        <span className="min-w-0 flex-1 truncate font-medium group-hover:underline">
          {project.name}
        </span>
        <span className="shrink-0 rounded border bg-muted px-1.5 py-0.5 font-mono text-[0.7rem] text-muted-foreground">
          {project.key}
        </span>
      </div>
      <p className="line-clamp-2 min-h-10 text-sm text-muted-foreground">
        {project.description || <span className="italic">No description</span>}
      </p>
      <div className="mt-auto flex items-center gap-4 text-xs text-muted-foreground">
        <span
          className="inline-flex items-center gap-1"
          title="Tasks someone is assigned to in their current stage"
        >
          <ListTodoIcon className="size-3.5" aria-hidden="true" />
          {pluralize(project.assignedTasks, 'task')} assigned
        </span>
        <span className="inline-flex items-center gap-1" title="Open issues">
          <CircleDotIcon className="size-3.5" aria-hidden="true" />
          {pluralize(project.openIssues, 'open issue')}
        </span>
      </div>
    </Link>
  );
}

interface MembersPreviewProps {
  members: Member[] | undefined;
  isPending: boolean;
  error: unknown;
  onRetry: () => void;
  teamSlug: string;
  canInvite: boolean;
  onInvite: () => void;
}

function MembersPreview({
  members,
  isPending,
  error,
  onRetry,
  teamSlug,
  canInvite,
  onInvite,
}: MembersPreviewProps) {
  if (isPending) {
    return (
      <div className="space-y-3 rounded-lg border p-3">
        {[0, 1, 2, 3].map((index) => (
          <div key={index} className="flex items-center gap-2">
            <Skeleton className="size-6 rounded-full" />
            <Skeleton className="h-4 flex-1" />
          </div>
        ))}
      </div>
    );
  }
  if (error || !members) {
    return <ErrorState title="Couldn’t load members" error={error} onRetry={onRetry} />;
  }
  const shown = members.slice(0, MEMBER_PREVIEW);
  const rest = members.length - shown.length;
  return (
    <div className="rounded-lg border">
      <ul className="divide-y">
        {shown.map((member) => {
          const [topRole] = member.roles;
          return (
            <li key={member.user.id} className="flex items-center gap-2 px-3 py-2">
              <UserAvatar user={member.user} size="md" />
              <UserName
                user={member.user}
                color={member.color}
                className="min-w-0 flex-1 text-sm"
              />
              {member.isOwner ? (
                <Badge variant="outline" className="shrink-0">
                  Owner
                </Badge>
              ) : topRole ? (
                <RoleChip role={topRole} className="shrink-0" />
              ) : null}
            </li>
          );
        })}
      </ul>
      <div className="flex flex-wrap items-center justify-between gap-2 border-t px-3 py-2">
        {rest > 0 ? (
          <Link
            to={`/t/${teamSlug}/members`}
            className="text-xs text-muted-foreground hover:text-foreground hover:underline"
          >
            and {pluralize(rest, 'more member')}
          </Link>
        ) : (
          <span className="text-xs text-muted-foreground">
            {members.length === 1 ? 'Just you so far.' : pluralize(members.length, 'member')}
          </span>
        )}
        {canInvite ? (
          <Button variant="ghost" size="xs" onClick={onInvite}>
            <UserPlusIcon aria-hidden="true" />
            Invite
          </Button>
        ) : null}
      </div>
    </div>
  );
}

function ProjectGridSkeleton() {
  return (
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3" aria-hidden="true">
      {[0, 1, 2].map((index) => (
        <div key={index} className="space-y-3 rounded-lg border p-4">
          <div className="flex items-center gap-3">
            <Skeleton className="size-6 rounded-md" />
            <Skeleton className="h-4 flex-1" />
          </div>
          <Skeleton className="h-3 w-full" />
          <Skeleton className="h-3 w-2/3" />
        </div>
      ))}
    </div>
  );
}

function TeamHomeSkeleton() {
  return (
    <PageContainer>
      <div className="flex items-start gap-4 border-b pb-6" role="status" aria-label="Loading team">
        <Skeleton className="size-16 rounded-2xl" />
        <div className="flex-1 space-y-2 pt-1">
          <Skeleton className="h-7 w-48" />
          <Skeleton className="h-4 w-72 max-w-full" />
        </div>
      </div>
      <div className="pt-6">
        <ProjectGridSkeleton />
      </div>
    </PageContainer>
  );
}
