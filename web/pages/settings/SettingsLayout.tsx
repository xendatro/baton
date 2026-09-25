import { useEffect, useRef } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router';
import { PageContainer } from '@web/components/common/PageContainer';
import { cn } from '@web/lib/utils';
import { SETTINGS_SECTIONS } from './sections';

/**
 * Account settings (SPEC §6 `/settings/*`): a section list on the left (a scrollable tab strip on
 * small screens) and the selected page on the right.
 */
export default function SettingsLayout() {
  const { pathname } = useLocation();
  const listRef = useRef<HTMLUListElement>(null);

  // On small screens the sections are a scrolling strip: keep the current one in view.
  useEffect(() => {
    const active = listRef.current?.querySelector<HTMLElement>('[aria-current="page"]');
    active?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  }, [pathname]);

  return (
    <PageContainer className="max-w-5xl">
      <header className="pb-5">
        <h1 className="text-xl font-semibold tracking-tight">Settings</h1>
        <p className="text-sm text-muted-foreground">
          Your profile, sign-in methods, API keys and preferences.
        </p>
      </header>
      <div className="flex flex-col gap-6 md:flex-row md:gap-10">
        <nav aria-label="Settings" className="-mx-4 shrink-0 px-4 md:mx-0 md:w-48 md:px-0">
          <ul
            ref={listRef}
            className="flex [scrollbar-width:none] gap-1 overflow-x-auto border-b pb-2 md:sticky md:top-4 md:flex-col md:overflow-visible md:border-b-0 md:pb-0"
          >
            {SETTINGS_SECTIONS.map(({ to, label, icon: Icon }) => (
              <li key={to} className="shrink-0">
                <NavLink
                  to={to}
                  className={({ isActive }) =>
                    cn(
                      'flex items-center gap-2 rounded-md px-2.5 py-1.5 text-sm whitespace-nowrap text-muted-foreground outline-none hover:bg-accent hover:text-accent-foreground focus-visible:ring-2 focus-visible:ring-ring/50',
                      isActive && 'bg-accent font-medium text-accent-foreground',
                    )
                  }
                >
                  <Icon className="size-4 shrink-0" aria-hidden="true" />
                  {label}
                </NavLink>
              </li>
            ))}
          </ul>
        </nav>
        <div className="min-w-0 flex-1">
          <Outlet />
        </div>
      </div>
    </PageContainer>
  );
}
