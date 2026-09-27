import {
  KanbanSquareIcon,
  ShieldIcon,
  SlidersHorizontalIcon,
  TagsIcon,
  type LucideIcon,
} from 'lucide-react';
import { NavLink, Outlet } from 'react-router';
import { PageContainer } from '@web/components/common/PageContainer';
import { useRouteContext } from '@web/lib/routeContext';
import { cn } from '@web/lib/utils';

/**
 * Project settings (`/t/:team/p/:key/settings/*`): a section nav (General, Statuses, Labels,
 * Access) beside the section. Every member who can see the project can open them; sections are
 * read-only without the matching permission (Manage projects, Manage statuses, Manage labels,
 * Manage project access).
 */

const SECTIONS: ReadonlyArray<{ to: string; label: string; icon: LucideIcon }> = [
  { to: 'general', label: 'General', icon: SlidersHorizontalIcon },
  { to: 'statuses', label: 'Statuses', icon: KanbanSquareIcon },
  { to: 'labels', label: 'Labels', icon: TagsIcon },
  { to: 'access', label: 'Access', icon: ShieldIcon },
];

export default function ProjectSettingsLayout() {
  const { team, project } = useRouteContext();
  if (!team || !project) return null;
  const base = `/t/${team.slug}/p/${project.key}/settings`;
  return (
    <PageContainer width="wide" className="max-w-5xl">
      <div className="grid gap-6 md:grid-cols-[11rem_minmax(0,1fr)]">
        <nav aria-label="Project settings" className="-mx-1 overflow-x-auto md:mx-0">
          <ul className="flex min-w-max gap-1 px-1 md:min-w-0 md:flex-col md:px-0">
            {SECTIONS.map((section) => {
              const Icon = section.icon;
              return (
                <li key={section.to}>
                  <NavLink
                    to={`${base}/${section.to}`}
                    className={({ isActive }) =>
                      cn(
                        'flex items-center gap-2 rounded-md px-2.5 py-1.5 text-sm font-medium transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring',
                        isActive
                          ? 'bg-accent text-accent-foreground'
                          : 'text-muted-foreground hover:bg-accent/60 hover:text-foreground',
                      )
                    }
                  >
                    <Icon className="size-4" aria-hidden="true" />
                    {section.label}
                  </NavLink>
                </li>
              );
            })}
          </ul>
        </nav>
        <div className="min-w-0">
          <Outlet />
        </div>
      </div>
    </PageContainer>
  );
}
