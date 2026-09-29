import {
  closestCenter,
  DndContext,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import { SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import {
  ArrowDownIcon,
  ArrowUpIcon,
  ChevronRightIcon,
  MoreHorizontalIcon,
  PinIcon,
  PinOffIcon,
  HomeIcon,
  HandIcon,
  InboxIcon,
  ListChecksIcon,
  MonitorDownIcon,
  BotIcon,
  FolderIcon,
  TerminalIcon,
  SettingsIcon,
  PlusIcon,
  SearchIcon,
  WorkflowIcon,
  type LucideIcon,
} from 'lucide-react';
import { Link, useLocation } from 'react-router';
import type { MeProject, MeTeam } from '@shared/schemas/core';
import { EntityIcon } from '@web/components/common/EntityIcon';
import { Kbd } from '@web/components/common/Kbd';
import { openPalette } from '@web/components/palette/registry';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@web/components/ui/collapsible';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@web/components/ui/dropdown-menu';
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSkeleton,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
  SidebarRail,
  useSidebar,
} from '@web/components/ui/sidebar';
import { useMe } from '@web/lib/auth';
import { isDesktopApp, useDesktopState } from '@web/lib/desktop';
import { pluralize } from '@web/lib/format';
import { runShellAction, useShellActionAvailable } from '@web/lib/shellActions';
import { cn } from '@web/lib/utils';
import { usePipelines } from '@web/pages/projects/queries';
import { pipelineBoardPath, resolvePipelineTab } from '@web/pages/tasks/pipelineTab';
import { DesktopUpdateNotice } from './DesktopUpdateNotice';
import { DesktopVersionLine } from './DesktopVersionLine';
import { LogoMark } from './Logo';
import {
  moveProject,
  moveTeam,
  useReorderMyProjects,
  useReorderMyTeams,
  useUpdateMyTeam,
} from './sidebarTeams';
import { usePendingRequestCount } from '@web/components/agentRequests/queries';
import { useUnreadCount } from './useUnreadCount';
import { UserMenu } from './UserMenu';

interface NavLinkProps {
  to: string;
  label: string;
  icon: LucideIcon;
  active: boolean;
  badge?: number;
  shortcut?: string;
}

function NavLink({ to, label, icon: Icon, active, badge, shortcut }: NavLinkProps) {
  const { setOpenMobile } = useSidebar();
  const count = badge ? (badge > 99 ? '99+' : String(badge)) : null;
  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        asChild
        isActive={active}
        tooltip={count ? `${label} (${count} unread)` : label}
        className="relative"
      >
        <Link
          to={to}
          onClick={() => setOpenMobile(false)}
          aria-current={active ? 'page' : undefined}
        >
          <Icon aria-hidden="true" />
          {count ? (
            // The count badge is hidden in the collapsed (icon) sidebar; a dot stands in for it.
            <span
              aria-hidden="true"
              className="absolute top-1 right-1 hidden size-2 rounded-full bg-primary ring-2 ring-sidebar group-data-[collapsible=icon]:block"
            />
          ) : null}
          <span>{label}</span>
          {count ? <span className="sr-only">({count} unread)</span> : null}
          {shortcut ? <span className="sr-only">(shortcut {shortcut})</span> : null}
        </Link>
      </SidebarMenuButton>
      {count ? (
        <SidebarMenuBadge
          className="rounded-full bg-primary px-1.5 text-primary-foreground peer-hover/menu-button:text-primary-foreground peer-data-[active=true]/menu-button:text-primary-foreground"
          aria-hidden="true"
        >
          {count}
        </SidebarMenuBadge>
      ) : null}
    </SidebarMenuItem>
  );
}

/**
 * dnd-kit stops the click that ends a drag before React sees it, but not its default action: the
 * dropped team's or project's link would open as a full page load. Cancel that click (if one comes).
 */
function swallowClick() {
  const prevent = (event: MouseEvent) => event.preventDefault();
  window.addEventListener('click', prevent, { capture: true, once: true });
  setTimeout(() => window.removeEventListener('click', prevent, { capture: true }), 300);
}

interface ProjectLinkProps {
  team: MeTeam;
  project: MeProject;
  /** Its neighbours in the team, for Move up / Move down (BAT#27). */
  above: MeProject | undefined;
  below: MeProject | undefined;
  draggable: boolean;
  onMove: (overId: string) => void;
  pathname: string;
  search: string;
}

function ProjectLink({
  team,
  project,
  above,
  below,
  draggable,
  onMove,
  pathname,
  search,
}: ProjectLinkProps) {
  const { setOpenMobile } = useSidebar();
  const { setNodeRef, setActivatorNodeRef, listeners, transform, transition, isDragging } =
    useSortable({ id: project.id, disabled: !draggable });
  const to = `/t/${team.slug}/p/${project.key}`;
  const active = pathname === to || pathname.startsWith(`${to}/`);
  // On its board the pipeline below is the highlighted item instead.
  const current = active && pathname !== `${to}/tasks`;
  return (
    <SidebarMenuSubItem
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      className={cn(isDragging && 'z-10 rounded-md bg-sidebar shadow-md ring-1 ring-border')}
    >
      {/* Its own hover group: the pipelines below don't reveal the project's menu. */}
      <div className="group/project-row relative">
        <SidebarMenuSubButton asChild isActive={current} className={cn(draggable && 'pr-7')}>
          <Link
            ref={setActivatorNodeRef}
            {...listeners}
            to={to}
            onClick={() => setOpenMobile(false)}
            aria-current={current ? 'page' : undefined}
            className={active ? 'font-medium' : undefined}
          >
            <EntityIcon icon={project.icon} name={project.name} color={project.color} />
            <span>{project.name}</span>
          </Link>
        </SidebarMenuSubButton>
        {draggable ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                aria-label={`${project.name} options`}
                className="absolute top-1 right-1 flex size-5 items-center justify-center rounded-md text-sidebar-foreground ring-sidebar-ring outline-hidden group-data-[collapsible=icon]:hidden hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:ring-2 data-[state=open]:opacity-100 md:opacity-0 md:group-focus-within/project-row:opacity-100 md:group-hover/project-row:opacity-100 [&>svg]:size-4 [&>svg]:shrink-0"
              >
                <MoreHorizontalIcon aria-hidden="true" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent side="right" align="start" className="w-44">
              <DropdownMenuItem disabled={!above} onSelect={() => above && onMove(above.id)}>
                <ArrowUpIcon aria-hidden="true" />
                Move up
              </DropdownMenuItem>
              <DropdownMenuItem disabled={!below} onSelect={() => below && onMove(below.id)}>
                <ArrowDownIcon aria-hidden="true" />
                Move down
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}
      </div>
      {/* The project you're in lists its pipelines (teams → projects → pipelines). */}
      {active ? (
        <ProjectPipelines projectBase={to} project={project} pathname={pathname} search={search} />
      ) : null}
    </SidebarMenuSubItem>
  );
}

/**
 * The active project's pipelines, each linking to its board with its open-task count. The one the
 * Tasks page shows is highlighted (the same tab its pipeline tabs resolve).
 */
function ProjectPipelines({
  projectBase,
  project,
  pathname,
  search,
}: {
  projectBase: string;
  project: MeProject;
  pathname: string;
  search: string;
}) {
  const { setOpenMobile } = useSidebar();
  const pipelines = usePipelines(project.id);
  const onBoard = pathname === `${projectBase}/tasks`;
  const tab = onBoard
    ? resolvePipelineTab(project.id, new URLSearchParams(search).get('pipeline'), pipelines.data)
    : undefined;
  if (pipelines.isPending) {
    return (
      <div className="mt-0.5 ml-3.5 border-l px-2.5 py-0.5" aria-hidden="true">
        <SidebarMenuSkeleton className="h-6" />
      </div>
    );
  }
  if (!pipelines.data?.length) return null;
  return (
    <ul
      aria-label={`${project.name} pipelines`}
      className="mt-0.5 ml-3.5 flex min-w-0 flex-col gap-0.5 border-l border-sidebar-border px-2.5 py-0.5 group-data-[collapsible=icon]:hidden"
    >
      {pipelines.data.map((pipeline) => {
        const current = tab === pipeline.id;
        const open = pipeline.openTaskCount ?? pipeline.taskCount;
        return (
          <li key={pipeline.id}>
            <SidebarMenuSubButton asChild size="sm" isActive={current}>
              <Link
                to={pipelineBoardPath(projectBase, pipeline.id)}
                onClick={() => setOpenMobile(false)}
                aria-current={current ? 'page' : undefined}
              >
                <WorkflowIcon aria-hidden="true" />
                <span>{pipeline.name}</span>
                <span className="ml-auto text-xs text-muted-foreground tabular-nums">
                  <span aria-hidden="true">{open}</span>
                  <span className="sr-only">({pluralize(open, 'open task')})</span>
                </span>
              </Link>
            </SidebarMenuSubButton>
          </li>
        );
      })}
    </ul>
  );
}

/**
 * A team's projects in your order (BAT#27): drag a project within its team (never to another
 * team), or use its menu (Move up, Move down), which the keyboard reaches too.
 */
function ProjectList({
  team,
  pathname,
  search,
}: {
  team: MeTeam;
  pathname: string;
  search: string;
}) {
  const reorder = useReorderMyProjects();
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));
  const projects = team.projects;
  const move = (activeId: string, overId: string) => {
    const next = moveProject(projects, activeId, overId);
    if (next) reorder.mutate({ teamId: team.id, projectIds: next });
  };
  const onDragEnd = ({ active, over }: DragEndEvent) => {
    swallowClick();
    if (over) move(String(active.id), String(over.id));
  };
  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragEnd={onDragEnd}
      onDragCancel={swallowClick}
      // Its live region and instructions go outside the list: a <ul> holds only list items.
      accessibility={{ container: document.body }}
    >
      <SortableContext
        items={projects.map((project) => project.id)}
        strategy={verticalListSortingStrategy}
      >
        {projects.map((project, index) => (
          <ProjectLink
            key={project.id}
            team={team}
            project={project}
            above={projects[index - 1]}
            below={projects[index + 1]}
            draggable={projects.length > 1}
            onMove={(overId) => move(project.id, overId)}
            pathname={pathname}
            search={search}
          />
        ))}
      </SortableContext>
    </DndContext>
  );
}

interface TeamItemProps {
  team: MeTeam;
  /** Its neighbours in the same group (Pinned, or the rest), for Move up / Move down. */
  above: MeTeam | undefined;
  below: MeTeam | undefined;
  draggable: boolean;
  onMove: (overId: string) => void;
  pathname: string;
  search: string;
}

function TeamItem({ team, above, below, draggable, onMove, pathname, search }: TeamItemProps) {
  const { setOpenMobile } = useSidebar();
  const update = useUpdateMyTeam();
  const { setNodeRef, setActivatorNodeRef, listeners, transform, transition, isDragging } =
    useSortable({ id: team.id, disabled: !draggable });
  const to = `/t/${team.slug}`;
  const inTeam = pathname === to || pathname.startsWith(`${to}/`);
  const open = !team.collapsed;
  const hasProjects = team.projects.length > 0;
  return (
    <Collapsible
      asChild
      open={open}
      onOpenChange={(next) => update.mutate({ teamId: team.id, collapsed: !next })}
    >
      <SidebarMenuItem
        ref={setNodeRef}
        style={{ transform: CSS.Translate.toString(transform), transition }}
        className={cn(isDragging && 'z-10 rounded-md bg-sidebar shadow-md ring-1 ring-border')}
      >
        <SidebarMenuButton
          asChild
          isActive={pathname === to}
          tooltip={team.name}
          className={cn(hasProjects && 'group-has-data-[sidebar=menu-action]/menu-item:pr-14')}
        >
          <Link
            ref={setActivatorNodeRef}
            {...listeners}
            to={to}
            onClick={() => setOpenMobile(false)}
            aria-current={pathname === to ? 'page' : undefined}
          >
            <EntityIcon icon={team.icon} name={team.name} color={team.color} />
            <span className={inTeam ? 'font-medium' : undefined}>{team.name}</span>
          </Link>
        </SidebarMenuButton>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <SidebarMenuAction
              showOnHover
              className={hasProjects ? 'right-7' : undefined}
              aria-label={`${team.name} options`}
            >
              <MoreHorizontalIcon aria-hidden="true" />
            </SidebarMenuAction>
          </DropdownMenuTrigger>
          <DropdownMenuContent side="right" align="start" className="w-44">
            <DropdownMenuItem
              onSelect={() => update.mutate({ teamId: team.id, pinned: !team.pinned })}
            >
              {team.pinned ? <PinOffIcon aria-hidden="true" /> : <PinIcon aria-hidden="true" />}
              {team.pinned ? 'Unpin' : 'Pin to top'}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem disabled={!above} onSelect={() => above && onMove(above.id)}>
              <ArrowUpIcon aria-hidden="true" />
              Move up
            </DropdownMenuItem>
            <DropdownMenuItem disabled={!below} onSelect={() => below && onMove(below.id)}>
              <ArrowDownIcon aria-hidden="true" />
              Move down
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        {hasProjects ? (
          <>
            <CollapsibleTrigger asChild>
              <SidebarMenuAction
                className="transition-transform data-[state=open]:rotate-90"
                aria-label={open ? `Collapse ${team.name}` : `Expand ${team.name}`}
              >
                <ChevronRightIcon aria-hidden="true" />
              </SidebarMenuAction>
            </CollapsibleTrigger>
            <CollapsibleContent>
              <SidebarMenuSub aria-label={`${team.name} projects`}>
                <ProjectList team={team} pathname={pathname} search={search} />
              </SidebarMenuSub>
            </CollapsibleContent>
          </>
        ) : null}
      </SidebarMenuItem>
    </Collapsible>
  );
}

/**
 * One group of teams (Pinned, or the rest) in your order (BAT-36): drag a team to move it within
 * its group, or use its menu (Pin to top, Move up, Move down), which the keyboard reaches too.
 */
function TeamList({
  teams,
  allTeams,
  pathname,
  search,
}: {
  teams: MeTeam[];
  allTeams: MeTeam[];
  pathname: string;
  search: string;
}) {
  const reorder = useReorderMyTeams();
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));
  const move = (activeId: string, overId: string) => {
    const next = moveTeam(allTeams, activeId, overId);
    if (next) reorder.mutate(next);
  };
  const onDragEnd = ({ active, over }: DragEndEvent) => {
    swallowClick();
    if (over) move(String(active.id), String(over.id));
  };
  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragEnd={onDragEnd}
      onDragCancel={swallowClick}
      // Its live region and instructions go outside the list: a <ul> holds only list items.
      accessibility={{ container: document.body }}
    >
      <SortableContext items={teams.map((team) => team.id)} strategy={verticalListSortingStrategy}>
        {teams.map((team, index) => (
          <TeamItem
            key={team.id}
            team={team}
            above={teams[index - 1]}
            below={teams[index + 1]}
            draggable={teams.length > 1}
            onMove={(overId) => move(team.id, overId)}
            pathname={pathname}
            search={search}
          />
        ))}
      </SortableContext>
    </DndContext>
  );
}

/** Left sidebar (SPEC §1.9): logo, search, Inbox, My tasks, Dashboard, teams tree, user menu. */
export function AppSidebar() {
  const { pathname, search } = useLocation();
  const me = useMe();
  const unread = useUnreadCount();
  const requests = usePendingRequestCount();
  const desktop = isDesktopApp();
  const canCreateTeam = useShellActionAvailable('team.create');
  const { setOpenMobile } = useSidebar();
  // In your order (BAT-36): the server sends pinned teams first.
  const teams = me.data?.teams ?? [];
  const pinned = teams.filter((team) => team.pinned);
  const unpinned = teams.filter((team) => !team.pinned);

  return (
    <Sidebar collapsible="icon">
      {/* One landmark for the whole sidebar: home, search, Inbox, My tasks, teams, account. */}
      <nav aria-label="Main" className="flex min-h-0 w-full flex-1 flex-col">
        <SidebarHeader>
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton asChild size="lg" tooltip="Baton">
                <Link
                  to="/"
                  onClick={() => setOpenMobile(false)}
                  aria-label="Baton home"
                  className="group-data-[collapsible=icon]:justify-center"
                >
                  <LogoMark className="size-7! group-data-[collapsible=icon]:size-6!" />
                  <span className="text-base font-semibold tracking-tight group-data-[collapsible=icon]:hidden">
                    Baton
                  </span>
                </Link>
              </SidebarMenuButton>
            </SidebarMenuItem>
            <SidebarMenuItem>
              <SidebarMenuButton
                tooltip="Search"
                onClick={() => {
                  setOpenMobile(false);
                  openPalette();
                }}
                className="border bg-background text-muted-foreground shadow-xs group-data-[collapsible=icon]:border-0 group-data-[collapsible=icon]:bg-transparent group-data-[collapsible=icon]:shadow-none hover:text-foreground"
              >
                <SearchIcon aria-hidden="true" />
                <span>Search…</span>
                <Kbd keys="mod+k" className="ml-auto group-data-[collapsible=icon]:hidden" />
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarHeader>
        <SidebarContent>
          <SidebarGroup>
            <SidebarGroupContent>
              <SidebarMenu>
                <NavLink
                  to="/inbox"
                  label="Inbox"
                  icon={InboxIcon}
                  active={pathname === '/inbox'}
                  badge={unread}
                  shortcut="g i"
                />
                <NavLink
                  to="/agent/requests"
                  label="Requests"
                  icon={HandIcon}
                  active={pathname === '/agent/requests'}
                  badge={requests}
                />
                <NavLink
                  to="/my-tasks"
                  label="My tasks"
                  icon={ListChecksIcon}
                  active={pathname === '/my-tasks'}
                  shortcut="g m"
                />
                <NavLink
                  to="/"
                  label="Dashboard"
                  icon={HomeIcon}
                  active={pathname === '/'}
                  shortcut="g d"
                />
                {desktop ? null : (
                  <NavLink
                    to="/download"
                    label="Desktop app"
                    icon={MonitorDownIcon}
                    active={pathname === '/download'}
                  />
                )}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
          {desktop ? <ThisComputer pathname={pathname} /> : null}
          {pinned.length ? (
            <SidebarGroup>
              <SidebarGroupLabel>Pinned</SidebarGroupLabel>
              <SidebarGroupContent>
                <SidebarMenu aria-label="Pinned teams">
                  <TeamList teams={pinned} allTeams={teams} pathname={pathname} search={search} />
                </SidebarMenu>
              </SidebarGroupContent>
            </SidebarGroup>
          ) : null}
          <SidebarGroup>
            <SidebarGroupLabel>Teams</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu aria-label="Teams">
                {me.isPending ? (
                  [0, 1, 2].map((index) => (
                    <SidebarMenuItem key={index}>
                      <SidebarMenuSkeleton showIcon />
                    </SidebarMenuItem>
                  ))
                ) : teams.length ? (
                  <TeamList teams={unpinned} allTeams={teams} pathname={pathname} search={search} />
                ) : (
                  <li className="px-2 py-1.5 text-xs text-muted-foreground group-data-[collapsible=icon]:hidden">
                    No teams yet. Create one, or ask a teammate for an invite link.
                  </li>
                )}
                {canCreateTeam ? (
                  <SidebarMenuItem>
                    <SidebarMenuButton
                      tooltip="New team"
                      className="text-muted-foreground"
                      onClick={() => {
                        setOpenMobile(false);
                        runShellAction('team.create');
                      }}
                    >
                      <PlusIcon aria-hidden="true" />
                      <span>New team</span>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                ) : null}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        </SidebarContent>
        <SidebarFooter>
          <SidebarMenu>
            <SidebarMenuItem>
              <UserMenu />
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarFooter>
      </nav>
      <SidebarRail />
    </Sidebar>
  );
}

/** The desktop app's own pages (BAT-26), only inside the Baton desktop app. */
function ThisComputer({ pathname }: { pathname: string }) {
  const { state } = useDesktopState();
  const requests = usePendingRequestCount();
  const running = state?.runner?.jobs.length ?? 0;
  return (
    <SidebarGroup>
      <SidebarGroupLabel>This computer</SidebarGroupLabel>
      <SidebarGroupContent>
        <SidebarMenu>
          <NavLink
            to="/desktop"
            label="Running agents"
            icon={BotIcon}
            active={pathname === '/desktop'}
            badge={running}
          />
          {/* Requests to start your agent, next to what runs (the main list has them too). */}
          <NavLink
            to="/agent/requests"
            label="Requests"
            icon={HandIcon}
            active={false}
            badge={requests}
          />
          <NavLink
            to="/desktop/folders"
            label="Folders"
            icon={FolderIcon}
            active={pathname === '/desktop/folders'}
          />
          <NavLink
            to="/desktop/harnesses"
            label="Harnesses"
            icon={TerminalIcon}
            active={pathname === '/desktop/harnesses'}
          />
          {/* Always there: setup has more steps than connecting, and they can be revisited. */}
          <NavLink
            to="/desktop/setup"
            label="Set up this computer"
            icon={SettingsIcon}
            active={pathname === '/desktop/setup'}
          />
        </SidebarMenu>
      </SidebarGroupContent>
      <DesktopVersionLine state={state} />
      <DesktopUpdateNotice update={state?.update} />
    </SidebarGroup>
  );
}
