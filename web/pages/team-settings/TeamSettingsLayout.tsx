import {
  LinkIcon,
  ScrollTextIcon,
  Settings2Icon,
  ShieldIcon,
  Trash2Icon,
  UsersIcon,
  type LucideIcon,
} from 'lucide-react';
import { useEffect, useRef } from 'react';
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router';
import type { Permission } from '@shared/permissions';
import type { MeTeam } from '@shared/schemas/core';
import { NotFound } from '@web/components/common/NotFound';
import { PageContainer } from '@web/components/common/PageContainer';
import { usePaletteCommands } from '@web/components/palette/registry';
import { Skeleton } from '@web/components/ui/skeleton';
import { useRouteContext } from '@web/lib/routeContext';
import { cn } from '@web/lib/utils';
import { TeamIcon } from '@web/pages/teams/TeamIcon';
import type { TeamSettingsContext } from './context';

interface SettingsItem {
  path: string;
  label: string;
  icon: LucideIcon;
  /** Shown when the viewer has any of these (always when absent). */
  anyOf?: Permission[];
}

const ITEMS: readonly SettingsItem[] = [
  { path: 'general', label: 'General', icon: Settings2Icon },
  { path: 'members', label: 'Members', icon: UsersIcon },
  { path: 'roles', label: 'Roles', icon: ShieldIcon },
  {
    path: 'invites',
    label: 'Invites',
    icon: LinkIcon,
    anyOf: ['CREATE_INVITES', 'MANAGE_INVITES'],
  },
  { path: 'audit-log', label: 'Audit log', icon: ScrollTextIcon, anyOf: ['VIEW_AUDIT_LOG'] },
  // Everyone sees Trash: authors can always restore their own items.
  { path: 'trash', label: 'Trash', icon: Trash2Icon },
];

/** The settings sections `team`'s viewer may open. */
function visibleSettingsItems(team: Pick<MeTeam, 'permissions'>): SettingsItem[] {
  return ITEMS.filter(
    (item) =>
      !item.anyOf ||
      item.anyOf.some(
        (permission) =>
          team.permissions.includes(permission) || team.permissions.includes('ADMINISTRATOR'),
      ),
  );
}

/** `/t/:team/settings/*`: a left nav (a scrolling tab row on phones) around the section. */
export default function TeamSettingsLayout() {
  const { team, isLoading } = useRouteContext();
  if (isLoading) return <LayoutSkeleton />;
  if (!team) return <NotFound what="Team" />;
  return <Layout team={team} />;
}

function Layout({ team }: { team: MeTeam }) {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const navRef = useRef<HTMLElement>(null);
  const items = visibleSettingsItems(team);
  // On phones the nav is a scrolling row: keep the current section in view.
  useEffect(() => {
    navRef.current
      ?.querySelector('[aria-current="page"]')
      ?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [pathname]);
  const base = `/t/${team.slug}/settings`;
  usePaletteCommands(
    items.map((item) => ({
      id: `team.settings.${item.path}`,
      label: `${team.name} settings: ${item.label}`,
      group: 'Team settings',
      icon: item.icon,
      keywords: [item.label],
      perform: () => void navigate(`${base}/${item.path}`),
    })),
  );
  const context: TeamSettingsContext = { team };

  return (
    <PageContainer className="max-w-5xl">
      <header className="flex items-center gap-3 pb-5">
        <TeamIcon icon={team.icon} name={team.name} color={team.color} size="md" />
        <div className="min-w-0">
          <p className="text-xs text-muted-foreground">
            <Link to={`/t/${team.slug}`} className="hover:text-foreground hover:underline">
              {team.name}
            </Link>
          </p>
          <h1 className="truncate text-xl font-semibold tracking-tight">Team settings</h1>
        </div>
      </header>
      <div className="flex flex-col gap-6 md:flex-row md:gap-8">
        <nav ref={navRef} aria-label="Team settings" className="shrink-0 md:w-48">
          <ul className="-mx-4 flex gap-1 overflow-x-auto border-b px-4 pb-2 md:mx-0 md:flex-col md:overflow-visible md:border-b-0 md:px-0 md:pb-0">
            {items.map((item) => (
              <li key={item.path} className="shrink-0">
                <NavLink
                  to={`${base}/${item.path}`}
                  className={({ isActive }) =>
                    cn(
                      'flex items-center gap-2 rounded-md px-2.5 py-1.5 text-sm whitespace-nowrap text-muted-foreground transition-colors outline-none hover:bg-accent hover:text-accent-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50',
                      isActive && 'bg-accent font-medium text-foreground',
                    )
                  }
                >
                  <item.icon className="size-4 shrink-0" aria-hidden="true" />
                  {item.label}
                </NavLink>
              </li>
            ))}
          </ul>
        </nav>
        <div className="min-w-0 flex-1">
          <Outlet context={context} />
        </div>
      </div>
    </PageContainer>
  );
}

function LayoutSkeleton() {
  return (
    <PageContainer className="max-w-5xl">
      <div className="flex items-center gap-3 pb-5" role="status" aria-label="Loading settings">
        <Skeleton className="size-9 rounded-lg" />
        <div className="space-y-1.5">
          <Skeleton className="h-3 w-20" />
          <Skeleton className="h-6 w-40" />
        </div>
      </div>
      <div className="flex gap-8">
        <div className="hidden w-48 space-y-2 md:block">
          {[0, 1, 2, 3].map((index) => (
            <Skeleton key={index} className="h-8 w-full" />
          ))}
        </div>
        <Skeleton className="h-64 flex-1" />
      </div>
    </PageContainer>
  );
}
