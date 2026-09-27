import { LayoutGridIcon, UsersIcon } from 'lucide-react';
import { Link } from 'react-router';
import { cn } from '@web/lib/utils';

const TABS = [
  { id: 'overview', label: 'Overview', icon: LayoutGridIcon, path: '' },
  { id: 'members', label: 'Members', icon: UsersIcon, path: '/members' },
] as const;

export type TeamTab = (typeof TABS)[number]['id'];

/** The team page's tabs: Overview (`/t/:team`) and Members (`/t/:team/members`, design §7). */
export function TeamTabs({
  teamSlug,
  active,
  className,
}: {
  teamSlug: string;
  active: TeamTab;
  className?: string;
}) {
  return (
    <nav aria-label="Team" className={cn('-mb-px overflow-x-auto', className)}>
      <ul className="flex min-w-max gap-1">
        {TABS.map((tab) => {
          const Icon = tab.icon;
          const current = tab.id === active;
          return (
            <li key={tab.id}>
              <Link
                to={`/t/${teamSlug}${tab.path}`}
                aria-current={current ? 'page' : undefined}
                className={cn(
                  'flex items-center gap-1.5 border-b-2 px-2.5 pt-1 pb-2.5 text-sm font-medium transition-colors outline-none focus-visible:rounded-sm focus-visible:ring-2 focus-visible:ring-ring',
                  current
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
  );
}
