import {
  ChevronRightIcon,
  HomeIcon,
  InboxIcon,
  ListChecksIcon,
  MonitorDownIcon,
  BotIcon,
  FolderIcon,
  TerminalIcon,
  SettingsIcon,
  PlusIcon,
  SearchIcon,
  type LucideIcon,
} from 'lucide-react';
import { useState } from 'react';
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
import { runShellAction, useShellActionAvailable } from '@web/lib/shellActions';
import { LogoMark } from './Logo';
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

function ProjectLink({
  team,
  project,
  pathname,
}: {
  team: MeTeam;
  project: MeProject;
  pathname: string;
}) {
  const { setOpenMobile } = useSidebar();
  const to = `/t/${team.slug}/p/${project.key}`;
  const active = pathname === to || pathname.startsWith(`${to}/`);
  return (
    <SidebarMenuSubItem>
      <SidebarMenuSubButton asChild isActive={active}>
        <Link
          to={to}
          onClick={() => setOpenMobile(false)}
          aria-current={active ? 'page' : undefined}
        >
          <EntityIcon icon={project.icon} name={project.name} color={project.color} />
          <span>{project.name}</span>
        </Link>
      </SidebarMenuSubButton>
    </SidebarMenuSubItem>
  );
}

function TeamItem({ team, pathname }: { team: MeTeam; pathname: string }) {
  const { setOpenMobile } = useSidebar();
  const to = `/t/${team.slug}`;
  const inTeam = pathname === to || pathname.startsWith(`${to}/`);
  const [open, setOpen] = useState(true);
  return (
    <Collapsible asChild open={open} onOpenChange={setOpen}>
      <SidebarMenuItem>
        <SidebarMenuButton asChild isActive={pathname === to} tooltip={team.name}>
          <Link
            to={to}
            onClick={() => setOpenMobile(false)}
            aria-current={pathname === to ? 'page' : undefined}
          >
            <EntityIcon icon={team.icon} name={team.name} color={team.color} />
            <span className={inTeam ? 'font-medium' : undefined}>{team.name}</span>
          </Link>
        </SidebarMenuButton>
        {team.projects.length ? (
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
              <SidebarMenuSub>
                {team.projects.map((project) => (
                  <ProjectLink key={project.id} team={team} project={project} pathname={pathname} />
                ))}
              </SidebarMenuSub>
            </CollapsibleContent>
          </>
        ) : null}
      </SidebarMenuItem>
    </Collapsible>
  );
}

/** Left sidebar (SPEC §1.9): logo, search, Inbox, My tasks, Dashboard, teams tree, user menu. */
export function AppSidebar() {
  const { pathname } = useLocation();
  const me = useMe();
  const unread = useUnreadCount();
  const desktop = isDesktopApp();
  const canCreateTeam = useShellActionAvailable('team.create');
  const { setOpenMobile } = useSidebar();
  const teams = me.data?.teams ?? [];

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
          <SidebarGroup>
            <SidebarGroupLabel>Teams</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                {me.isPending ? (
                  [0, 1, 2].map((index) => (
                    <SidebarMenuItem key={index}>
                      <SidebarMenuSkeleton showIcon />
                    </SidebarMenuItem>
                  ))
                ) : teams.length ? (
                  teams.map((team) => <TeamItem key={team.id} team={team} pathname={pathname} />)
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
          {state && !state.connected ? (
            <NavLink
              to="/desktop/setup"
              label="Set up this computer"
              icon={SettingsIcon}
              active={pathname === '/desktop/setup'}
            />
          ) : null}
        </SidebarMenu>
      </SidebarGroupContent>
    </SidebarGroup>
  );
}
