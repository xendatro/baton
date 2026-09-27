import { useQueryClient } from '@tanstack/react-query';
import {
  FileTextIcon,
  KanbanSquareIcon,
  MessagesSquareIcon,
  SettingsIcon,
  TagsIcon,
  UserCogIcon,
  type LucideIcon,
} from 'lucide-react';
import { useState } from 'react';
import { Link, Navigate, Outlet, useLocation, useNavigate, useParams } from 'react-router';
import type { MeProject, MeTeam } from '@shared/schemas/core';
import { EntityIcon } from '@web/components/common/EntityIcon';
import { NotFound } from '@web/components/common/NotFound';
import { usePaletteCommands } from '@web/components/palette/registry';
import { Button } from '@web/components/ui/button';
import { Skeleton } from '@web/components/ui/skeleton';
import { useLiveEventListener } from '@web/lib/live';
import { queryKeys } from '@web/lib/queryKeys';
import { useRouteContext } from '@web/lib/routeContext';
import { cn } from '@web/lib/utils';
import { useIsDeleting, useProject, useProjectByKey } from './queries';

/**
 * Layout of every page of a project (`/t/:team/p/:key/*`): the header (icon, name, key,
 * description) and the Overview / Tasks / Issues / Settings tabs. It resolves the URL's key
 * through `me`; an old key (the project was re-keyed) redirects to the current URL, a lowercase
 * key to the canonical one, and anything else is a 404 for the whole subtree.
 */
export default function ProjectLayout() {
  const { team, project, isLoading } = useRouteContext();
  const params = useParams();
  const location = useLocation();
  // The project last shown here: while the viewer deletes it, it vanishes from `me` before the
  // page navigates away, and must not be looked up as an old key meanwhile.
  const [shown, setShown] = useState<MeProject | null>(project);
  if (project && project !== shown) setShown(project);
  const deletingShown = useIsDeleting(shown?.id);

  if (isLoading) return <ProjectHeaderSkeleton />;
  if (!team) return <NotFound what="Project" />;
  const urlKey = params.key ?? '';
  if (!project && deletingShown) return <ProjectHeaderSkeleton />;
  if (!project) return <OldKeyRedirect team={team} urlKey={urlKey.toUpperCase()} />;
  if (urlKey !== project.key) {
    return <Navigate replace to={rewriteKey(location, team.slug, urlKey, project.key)} />;
  }
  return <ProjectFrame team={team} project={project} />;
}

/** The current location with the project key segment replaced. */
function rewriteKey(
  location: { pathname: string; search: string; hash: string },
  teamSlug: string,
  fromKey: string,
  toKey: string,
): string {
  const prefix = `/t/${teamSlug}/p/`;
  const start = location.pathname.toLowerCase().indexOf(prefix.toLowerCase());
  const rest = start === -1 ? '' : location.pathname.slice(start + prefix.length + fromKey.length);
  return `${prefix}${toKey}${rest}${location.search}${location.hash}`;
}

function OldKeyRedirect({ team, urlKey }: { team: MeTeam; urlKey: string }) {
  const location = useLocation();
  const resolved = useProjectByKey(team.slug, team.id, urlKey, urlKey.length > 0);
  if (resolved.isPending && urlKey.length > 0) return <ProjectHeaderSkeleton />;
  if (!resolved.data || resolved.data.teamId !== team.id) return <NotFound what="Project" />;
  return <Navigate replace to={rewriteKey(location, team.slug, urlKey, resolved.data.key)} />;
}

interface Tab {
  to: string;
  label: string;
  icon: LucideIcon;
  active: boolean;
}

function ProjectFrame({ team, project }: { team: MeTeam; project: MeProject }) {
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const details = useProject(project.id);
  const base = `/t/${team.slug}/p/${project.key}`;
  const [section = '', item] = pathname.slice(base.length).split('/').slice(1);
  // On a task or issue page (and New issue) the item is the page's h1; the project name is not.
  const ProjectName = (section === 'tasks' || section === 'issues') && item ? 'p' : 'h1';

  // The project's counts and statuses change with its tasks, issues, statuses and labels.
  useLiveEventListener((event) => {
    if (event.projectId !== project.id) return;
    if (/^(task|issue|status|label)\./.test(event.type)) {
      void queryClient.invalidateQueries({
        queryKey: queryKeys.projects.detail(project.id),
        exact: true,
      });
    }
  });

  const tabs: Tab[] = [
    { to: base, label: 'Overview', icon: FileTextIcon, active: section === '' },
    { to: `${base}/tasks`, label: 'Tasks', icon: KanbanSquareIcon, active: section === 'tasks' },
    {
      to: `${base}/issues`,
      label: 'Issues',
      icon: MessagesSquareIcon,
      active: section === 'issues',
    },
    {
      to: `${base}/settings`,
      label: 'Settings',
      icon: SettingsIcon,
      active: section === 'settings',
    },
  ];

  usePaletteCommands([
    {
      id: `project.${project.id}.overview`,
      label: `${project.name} › Overview`,
      group: 'Project',
      icon: FileTextIcon,
      keywords: [project.key, 'readme', 'project overview'],
      perform: () => void navigate(base),
    },
    {
      id: `project.${project.id}.settings`,
      label: `${project.name} › Settings`,
      group: 'Project',
      icon: SettingsIcon,
      keywords: [project.key, 'project settings', 'rename', 'key'],
      perform: () => void navigate(`${base}/settings/general`),
    },
    {
      id: `project.${project.id}.statuses`,
      label: `${project.name} › Statuses`,
      group: 'Project',
      icon: KanbanSquareIcon,
      keywords: [project.key, 'workflow', 'columns', 'status settings'],
      perform: () => void navigate(`${base}/settings/statuses`),
    },
    {
      id: `project.${project.id}.labels`,
      label: `${project.name} › Labels`,
      group: 'Project',
      icon: TagsIcon,
      keywords: [project.key, 'tags', 'label settings'],
      perform: () => void navigate(`${base}/settings/labels`),
    },
    {
      id: `project.${project.id}.me`,
      label: `${project.name} › Your project settings`,
      group: 'Project',
      icon: UserCogIcon,
      keywords: [project.key, 'your project settings', 'my notifications', 'my models'],
      perform: () => void navigate(`${base}/me`),
    },
  ]);

  const description = details.data?.description ?? '';
  return (
    <div className="flex min-w-0 flex-1 flex-col">
      <header className="border-b bg-background">
        <div className="flex items-start gap-3 px-4 pt-4 sm:px-6 sm:pt-5">
          <EntityIcon
            icon={project.icon}
            name={project.name}
            color={project.color}
            className="mt-0.5 size-9 rounded-lg text-xl sm:size-10 sm:text-2xl"
          />
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 items-center gap-2">
              <ProjectName className="truncate text-lg leading-tight font-semibold tracking-tight sm:text-xl">
                {project.name}
              </ProjectName>
              <span
                className="shrink-0 rounded-md border bg-muted px-1.5 py-0.5 font-mono text-xs text-muted-foreground"
                title="Project key"
              >
                {project.key}
              </span>
            </div>
            {details.isPending ? (
              <Skeleton className="mt-1.5 h-4 w-64 max-w-full" />
            ) : description ? (
              <p
                className="mt-1 line-clamp-2 text-sm text-muted-foreground sm:line-clamp-1"
                title={description}
              >
                {description}
              </p>
            ) : null}
          </div>
          <Button
            asChild
            size="sm"
            variant={section === 'me' ? 'secondary' : 'ghost'}
            className="shrink-0"
          >
            <Link
              to={`${base}/me`}
              aria-label="Your settings for this project"
              aria-current={section === 'me' ? 'page' : undefined}
            >
              <UserCogIcon aria-hidden="true" />
              <span className="hidden sm:inline">Your settings</span>
            </Link>
          </Button>
        </div>
        <nav aria-label="Project" className="-mb-px overflow-x-auto px-2 sm:px-4">
          <ul className="flex min-w-max gap-1 pt-3">
            {tabs.map((tab) => {
              const Icon = tab.icon;
              return (
                <li key={tab.label}>
                  <Link
                    to={tab.to}
                    aria-current={tab.active ? 'page' : undefined}
                    className={cn(
                      'flex items-center gap-1.5 border-b-2 px-2.5 pt-1 pb-2.5 text-sm font-medium transition-colors outline-none focus-visible:rounded-sm focus-visible:ring-2 focus-visible:ring-ring',
                      tab.active
                        ? 'border-primary text-foreground'
                        : 'border-transparent text-muted-foreground hover:border-border hover:text-foreground',
                    )}
                  >
                    <Icon className="hidden size-4 sm:block" aria-hidden="true" />
                    {tab.label}
                  </Link>
                </li>
              );
            })}
          </ul>
        </nav>
      </header>
      <Outlet />
    </div>
  );
}

function ProjectHeaderSkeleton() {
  return (
    <div
      className="border-b px-4 pt-4 pb-3 sm:px-6 sm:pt-5"
      role="status"
      aria-label="Loading project"
    >
      <div className="flex items-start gap-3">
        <Skeleton className="size-10 rounded-lg" />
        <div className="grid flex-1 gap-2">
          <Skeleton className="h-5 w-48" />
          <Skeleton className="h-4 w-72 max-w-full" />
        </div>
      </div>
      <div className="mt-4 flex gap-4">
        {[0, 1, 2, 3].map((index) => (
          <Skeleton key={index} className="h-5 w-16" />
        ))}
      </div>
    </div>
  );
}
