import { format } from 'date-fns';
import {
  AlarmClockIcon,
  BotIcon,
  CalendarClockIcon,
  CircleDotIcon,
  FolderKanbanIcon,
  HistoryIcon,
  ListChecksIcon,
  ListTodoIcon,
  PlusIcon,
  UsersIcon,
  type LucideIcon,
} from 'lucide-react';
import type { ReactNode } from 'react';
import { Link } from 'react-router';
import type { MeTeam, MeUser } from '@shared/schemas/core';
import type { DashboardResponse, DashboardTeam, MyTask } from '@shared/schemas/work';
import { EntityIcon } from '@web/components/common/EntityIcon';
import { ErrorState } from '@web/components/common/ErrorState';
import { PageContainer } from '@web/components/common/PageContainer';
import { PageHeader } from '@web/components/common/PageHeader';
import { useNow } from '@web/components/common/useNow';
import { Button } from '@web/components/ui/button';
import { Skeleton } from '@web/components/ui/skeleton';
import { useMe } from '@web/lib/auth';
import { pluralize } from '@web/lib/format';
import { runShellAction, useShellActionAvailable } from '@web/lib/shellActions';
import { cn } from '@web/lib/utils';
import { useDashboard } from '@web/pages/my-tasks/queries';
import { WorkTaskRow } from '@web/pages/my-tasks/WorkTaskRow';
import { TeamIcon } from '@web/pages/teams/TeamIcon';
import { ActivityFeed } from './ActivityFeed';
import { firstName, greeting } from './invite';
import { JoinWithLink } from './JoinWithLink';

/** `/`: what needs my attention across my teams, or a first-run welcome without teams. */
export default function DashboardPage() {
  const me = useMe();
  const now = new Date(useNow());
  const user = me.data?.user;
  const description = user
    ? `${greeting(now)}, ${firstName(user.name)}. It’s ${format(now, 'EEEE, MMMM d')}.`
    : undefined;

  return (
    <PageContainer>
      <PageHeader title="Dashboard" description={description} />
      {me.isPending ? (
        <DashboardSkeleton />
      ) : me.isError ? (
        <ErrorState
          title="Couldn’t load your account"
          error={me.error}
          onRetry={() => void me.refetch()}
        />
      ) : me.data.teams.length === 0 ? (
        <FirstRun user={me.data.user} />
      ) : (
        <Dashboard teams={me.data.teams} />
      )}
    </PageContainer>
  );
}

function Dashboard({ teams }: { teams: MeTeam[] }) {
  const dashboard = useDashboard();
  if (dashboard.isPending) return <DashboardSkeleton />;
  if (dashboard.isError) {
    return (
      <ErrorState
        title="Couldn’t load your dashboard"
        error={dashboard.error}
        onRetry={() => void dashboard.refetch()}
      />
    );
  }
  const data = dashboard.data;
  return (
    <div className="space-y-8">
      <StatCards data={data} />
      <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_20rem] xl:grid-cols-[minmax(0,1fr)_24rem]">
        <div className="min-w-0 space-y-8">
          <AssignedSection data={data} teams={teams} />
          <DueSection data={data} />
          <ClaimedSection data={data} />
        </div>
        <Section
          id="activity"
          title="Recent activity"
          icon={HistoryIcon}
          className="min-w-0 lg:self-start"
        >
          {data.activity.length === 0 ? (
            <QuietState icon={HistoryIcon}>
              Nothing has happened in your teams yet. Changes to tasks and issues show up here.
            </QuietState>
          ) : (
            <ActivityFeed entries={data.activity} teams={teams} />
          )}
        </Section>
      </div>
      <TeamsSection teams={data.teams} />
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Stat cards
// ---------------------------------------------------------------------------------------------

interface StatCardProps {
  label: string;
  value: number;
  hint: string;
  icon: LucideIcon;
  to?: string;
  onClick?: () => void;
  tone?: 'danger' | 'warning' | 'success';
}

const TONES = {
  danger: 'text-red-600 dark:text-red-400',
  warning: 'text-amber-700 dark:text-amber-400',
  success: 'text-emerald-600 dark:text-emerald-400',
} as const;

function StatCard({ label, value, hint, icon: Icon, to, onClick, tone }: StatCardProps) {
  const active = value > 0 && tone;
  const content = (
    <>
      <span className="flex items-center justify-between gap-2 text-sm text-muted-foreground">
        {label}
        <Icon className={cn('size-4', active ? TONES[tone] : undefined)} aria-hidden="true" />
      </span>
      <span
        className={cn(
          'text-2xl font-semibold tracking-tight tabular-nums',
          active ? TONES[tone] : 'text-foreground',
        )}
      >
        {value}
      </span>
      <span className="line-clamp-2 text-xs text-muted-foreground">{hint}</span>
    </>
  );
  const className =
    'flex min-w-0 flex-col gap-1 rounded-lg border bg-card p-4 text-left transition-colors outline-none hover:border-foreground/20 hover:bg-accent/40 focus-visible:ring-[3px] focus-visible:ring-ring/50';
  return to ? (
    <Link to={to} className={className} aria-label={`${label}: ${value}. ${hint}`}>
      {content}
    </Link>
  ) : (
    <button
      type="button"
      onClick={onClick}
      className={className}
      aria-label={`${label}: ${value}. ${hint}`}
    >
      {content}
    </button>
  );
}

function StatCards({ data }: { data: DashboardResponse }) {
  const { counts } = data;
  const showClaimed = () => {
    const section = document.getElementById('claimed');
    section?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    section?.focus({ preventScroll: true });
  };
  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      <StatCard
        label="Assigned to you"
        value={counts.assigned}
        hint="Open, for you or your roles"
        icon={ListTodoIcon}
        to="/my-tasks"
      />
      <StatCard
        label="Overdue"
        value={counts.overdue}
        hint="Past their due date"
        icon={AlarmClockIcon}
        to="/my-tasks?due=overdue"
        tone="danger"
      />
      <StatCard
        label="Due this week"
        value={counts.dueSoon}
        hint="In the next 7 days"
        icon={CalendarClockIcon}
        to="/my-tasks?due=week"
        tone="warning"
      />
      <StatCard
        label="Claimed"
        value={counts.claimed}
        hint="By you or your agents"
        icon={BotIcon}
        onClick={showClaimed}
        tone="success"
      />
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------------------------

interface SectionProps {
  id: string;
  title: string;
  icon: LucideIcon;
  count?: number;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}

function Section({ id, title, icon: Icon, count, action, children, className }: SectionProps) {
  return (
    <section
      id={id}
      aria-labelledby={`${id}-title`}
      className={cn('space-y-3', className)}
      tabIndex={-1}
    >
      <div className="flex min-h-7 items-center gap-2">
        <Icon className="size-4 text-muted-foreground" aria-hidden="true" />
        <h2 id={`${id}-title`} className="text-sm font-semibold">
          {title}
        </h2>
        {count !== undefined && count > 0 ? (
          <span className="rounded-full bg-muted px-1.5 text-xs font-medium text-muted-foreground tabular-nums">
            {count}
          </span>
        ) : null}
        {action ? <div className="ml-auto">{action}</div> : null}
      </div>
      <div className="overflow-hidden rounded-lg border bg-card">{children}</div>
    </section>
  );
}

/** A small, calm empty state inside a section card. */
function QuietState({
  icon: Icon,
  children,
  action,
}: {
  icon: LucideIcon;
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-start gap-3 px-4 py-5 text-sm text-muted-foreground sm:flex-row sm:items-center">
      <Icon className="size-4 shrink-0" aria-hidden="true" />
      <p className="flex-1">{children}</p>
      {action}
    </div>
  );
}

function TaskList({
  tasks,
  claimBadge = false,
}: {
  tasks: readonly MyTask[];
  claimBadge?: boolean;
}) {
  return (
    <ul className="divide-y">
      {tasks.map((task) => (
        <WorkTaskRow key={task.id} task={task} showContext claimBadge={claimBadge} />
      ))}
    </ul>
  );
}

function AssignedSection({ data, teams }: { data: DashboardResponse; teams: MeTeam[] }) {
  const firstProject = teams.flatMap((team) =>
    team.projects.map((project) => ({ team, project })),
  )[0];
  const more = data.counts.assigned - data.assigned.length;
  return (
    <Section
      id="assigned"
      title="Assigned to you"
      icon={ListChecksIcon}
      count={data.counts.assigned}
      action={
        data.counts.assigned > 0 ? (
          <Button variant="link" size="sm" className="h-auto px-0" asChild>
            <Link to="/my-tasks">View all</Link>
          </Button>
        ) : null
      }
    >
      {data.assigned.length === 0 ? (
        <QuietState
          icon={ListChecksIcon}
          action={
            firstProject ? (
              <Button variant="outline" size="sm" asChild>
                <Link to={`/t/${firstProject.team.slug}/p/${firstProject.project.key}/tasks`}>
                  Browse {firstProject.project.name}
                </Link>
              </Button>
            ) : null
          }
        >
          Nothing is assigned to you or your roles right now.
        </QuietState>
      ) : (
        <>
          <TaskList tasks={data.assigned} />
          {more > 0 ? (
            <Link
              to="/my-tasks"
              className="block border-t px-4 py-2 text-center text-xs text-muted-foreground hover:bg-accent/40 hover:text-foreground"
            >
              {pluralize(more, 'more task')} in My tasks
            </Link>
          ) : null}
        </>
      )}
    </Section>
  );
}

function DueSection({ data }: { data: DashboardResponse }) {
  const empty = data.overdue.length === 0 && data.dueSoon.length === 0;
  return (
    <Section
      id="due"
      title="Overdue and due soon"
      icon={CalendarClockIcon}
      count={data.counts.overdue + data.counts.dueSoon}
    >
      {empty ? (
        <QuietState icon={CalendarClockIcon}>
          Nothing overdue, and nothing due in the next 7 days.
        </QuietState>
      ) : (
        <>
          {data.overdue.length > 0 ? (
            <DueGroup
              label="Overdue"
              count={data.counts.overdue}
              tasks={data.overdue}
              to="/my-tasks?due=overdue&sort=due"
              danger
            />
          ) : null}
          {data.dueSoon.length > 0 ? (
            <DueGroup
              label="Due this week"
              count={data.counts.dueSoon}
              tasks={data.dueSoon}
              to="/my-tasks?due=week&sort=due"
            />
          ) : null}
        </>
      )}
    </Section>
  );
}

function DueGroup({
  label,
  count,
  tasks,
  to,
  danger = false,
}: {
  label: string;
  count: number;
  tasks: readonly MyTask[];
  to: string;
  danger?: boolean;
}) {
  return (
    <div className="border-b last:border-b-0">
      <div className="flex items-center gap-2 border-b bg-muted/40 px-3 py-1.5 text-xs font-medium sm:px-4">
        <span className={cn(danger ? 'text-red-700 dark:text-red-400' : 'text-muted-foreground')}>
          {label}
        </span>
        <span className="text-muted-foreground tabular-nums">{count}</span>
        {count > tasks.length ? (
          <Link
            to={to}
            className="ml-auto text-muted-foreground hover:text-foreground hover:underline"
          >
            View all
          </Link>
        ) : null}
      </div>
      <TaskList tasks={tasks} />
    </div>
  );
}

function ClaimedSection({ data }: { data: DashboardResponse }) {
  return (
    <Section
      id="claimed"
      title="Claimed by you and your agents"
      icon={BotIcon}
      count={data.counts.claimed}
    >
      {data.claimed.length === 0 ? (
        <QuietState icon={BotIcon}>
          No active claims. Claim a task to show you’re on it; agents with your API keys claim tasks
          with <code className="font-mono text-xs text-foreground">claim_next_task</code>.
        </QuietState>
      ) : (
        <TaskList tasks={data.claimed} claimBadge />
      )}
    </Section>
  );
}

// ---------------------------------------------------------------------------------------------
// Teams & projects
// ---------------------------------------------------------------------------------------------

function TeamsSection({ teams }: { teams: DashboardTeam[] }) {
  return (
    <section aria-labelledby="teams-title" className="space-y-3">
      <div className="flex min-h-7 items-center gap-2">
        <FolderKanbanIcon className="size-4 text-muted-foreground" aria-hidden="true" />
        <h2 id="teams-title" className="text-sm font-semibold">
          Teams and projects
        </h2>
      </div>
      <ul className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {teams.map((team) => (
          <li key={team.id}>
            <TeamCard team={team} />
          </li>
        ))}
      </ul>
    </section>
  );
}

function TeamCard({ team }: { team: DashboardTeam }) {
  const me = useMe().data;
  const canCreateProject =
    useShellActionAvailable('project.create') &&
    (me?.teams
      .find((candidate) => candidate.id === team.id)
      ?.permissions.includes('MANAGE_PROJECTS') ??
      false);
  return (
    <div className="flex h-full flex-col rounded-lg border bg-card">
      <div className="flex items-center gap-3 border-b px-4 py-3">
        <TeamIcon icon={team.icon} name={team.name} color={team.color} size="sm" />
        <Link
          to={team.url}
          className="min-w-0 flex-1 truncate font-medium outline-none hover:underline focus-visible:underline"
        >
          {team.name}
        </Link>
        <span
          className="inline-flex shrink-0 items-center gap-1 text-xs text-muted-foreground"
          title={pluralize(team.memberCount, 'member')}
        >
          <UsersIcon className="size-3.5" aria-hidden="true" />
          <span className="sr-only">Members:</span>
          {team.memberCount}
        </span>
      </div>
      {team.projects.length === 0 ? (
        <div className="flex flex-1 flex-col items-start gap-2 px-4 py-4 text-sm text-muted-foreground">
          <p>No projects yet.</p>
          {canCreateProject ? (
            <Button
              variant="outline"
              size="sm"
              onClick={() => runShellAction('project.create', { teamId: team.id })}
            >
              <PlusIcon aria-hidden="true" />
              New project
            </Button>
          ) : null}
        </div>
      ) : (
        <ul className="divide-y">
          {team.projects.map((project) => (
            <li key={project.id}>
              <Link
                to={project.url}
                className="flex items-center gap-2.5 px-4 py-2 text-sm outline-none hover:bg-accent/40 focus-visible:bg-accent/40 focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-inset"
              >
                <EntityIcon icon={project.icon} name={project.name} color={project.color} />
                <span className="min-w-0 flex-1 truncate">{project.name}</span>
                <span
                  className="inline-flex items-center gap-1 text-xs text-muted-foreground tabular-nums"
                  title={pluralize(project.openTasks, 'open task')}
                >
                  <ListTodoIcon className="size-3.5" aria-hidden="true" />
                  <span className="sr-only">Open tasks:</span>
                  {project.openTasks}
                </span>
                <span
                  className="inline-flex w-10 items-center gap-1 text-xs text-muted-foreground tabular-nums"
                  title={pluralize(project.openIssues, 'open issue')}
                >
                  <CircleDotIcon className="size-3.5" aria-hidden="true" />
                  <span className="sr-only">Open issues:</span>
                  {project.openIssues}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// First run
// ---------------------------------------------------------------------------------------------

function FirstRun({ user }: { user: MeUser }) {
  const canCreateTeam = useShellActionAvailable('team.create');
  return (
    <div className="rounded-xl border bg-card px-6 py-10 sm:px-10">
      <div className="mx-auto max-w-2xl space-y-8">
        <div className="space-y-2 text-center">
          <span className="mx-auto flex size-12 items-center justify-center rounded-full bg-primary/10 text-primary">
            <UsersIcon className="size-6" aria-hidden="true" />
          </span>
          <h2 className="text-lg font-semibold tracking-tight">
            Welcome to Baton, {firstName(user.name)}
          </h2>
          <p className="text-sm text-muted-foreground">
            Teams are where people and their agents share projects, issues and tasks. Start your
            own, or join one with an invite link from a teammate.
          </p>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="flex flex-col gap-3 rounded-lg border p-5">
            <div className="space-y-1">
              <h3 className="text-sm font-semibold">Create a team</h3>
              <p className="text-sm text-muted-foreground">
                You’ll be its owner and can invite people right away.
              </p>
            </div>
            {canCreateTeam ? (
              <Button className="mt-auto self-start" onClick={() => runShellAction('team.create')}>
                <PlusIcon aria-hidden="true" />
                Create a team
              </Button>
            ) : null}
          </div>
          <div className="flex flex-col gap-3 rounded-lg border p-5">
            <div className="space-y-1">
              <h3 className="text-sm font-semibold">Join with an invite link</h3>
              <p className="text-sm text-muted-foreground">
                Paste the link or code someone shared with you.
              </p>
            </div>
            <JoinWithLink className="mt-auto" />
          </div>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Skeleton
// ---------------------------------------------------------------------------------------------

function DashboardSkeleton() {
  return (
    <div className="space-y-8" role="status" aria-label="Loading your dashboard">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {[0, 1, 2, 3].map((index) => (
          <div key={index} className="space-y-2 rounded-lg border p-4">
            <Skeleton className="h-4 w-24" />
            <Skeleton className="h-7 w-10" />
            <Skeleton className="h-3 w-28 max-w-full" />
          </div>
        ))}
      </div>
      <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_20rem] xl:grid-cols-[minmax(0,1fr)_24rem]">
        <div className="space-y-3">
          <Skeleton className="h-4 w-32" />
          <div className="rounded-lg border">
            {[0, 1, 2, 3, 4].map((index) => (
              <div
                key={index}
                className="flex items-center gap-3 border-b px-4 py-3 last:border-b-0"
              >
                <Skeleton className="size-4" />
                <Skeleton className="h-3 w-12" />
                <Skeleton className="h-4 flex-1" />
                <Skeleton className="h-3 w-14" />
              </div>
            ))}
          </div>
        </div>
        <div className="space-y-3">
          <Skeleton className="h-4 w-28" />
          <div className="space-y-3 rounded-lg border p-4">
            {[0, 1, 2, 3].map((index) => (
              <div key={index} className="flex gap-2.5">
                <Skeleton className="size-6 rounded-full" />
                <div className="flex-1 space-y-1.5">
                  <Skeleton className="h-3.5 w-full" />
                  <Skeleton className="h-3 w-24" />
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
