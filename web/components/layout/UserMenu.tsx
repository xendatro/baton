import {
  ChevronsUpDownIcon,
  KeyboardIcon,
  LogOutIcon,
  MonitorIcon,
  MoonIcon,
  SettingsIcon,
  SunIcon,
} from 'lucide-react';
import { Link } from 'react-router';
import { THEMES, type Theme } from '@shared/constants';
import { UserAvatar } from '@web/components/common/UserAvatar';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@web/components/ui/dropdown-menu';
import { SidebarMenuButton, useSidebar } from '@web/components/ui/sidebar';
import { useMe, useSignOut } from '@web/lib/auth';
import { setShortcutsHelpOpen } from '@web/lib/hotkeys';
import { useTheme } from '@web/lib/theme';

const THEME_OPTIONS: Record<Theme, { label: string; icon: typeof SunIcon }> = {
  system: { label: 'System', icon: MonitorIcon },
  light: { label: 'Light', icon: SunIcon },
  dark: { label: 'Dark', icon: MoonIcon },
};

function isTheme(value: string): value is Theme {
  return (THEMES as readonly string[]).includes(value);
}

/** Avatar button at the bottom of the sidebar: settings, theme, shortcuts, sign out. */
export function UserMenu() {
  const me = useMe().data;
  const signOut = useSignOut();
  const { theme, setTheme } = useTheme();
  const { isMobile, setOpenMobile } = useSidebar();
  if (!me) return null;
  const { user } = me;
  const summary = { id: user.id, name: user.name, username: user.username, image: user.image };
  const ThemeIcon = THEME_OPTIONS[theme].icon;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <SidebarMenuButton
          size="lg"
          className="data-[state=open]:bg-sidebar-accent data-[state=open]:text-sidebar-accent-foreground"
          aria-label="Account menu"
        >
          <UserAvatar user={summary} size="lg" />
          <span className="grid min-w-0 flex-1 text-left leading-tight">
            <span className="truncate text-sm font-medium">{user.name}</span>
            <span className="truncate text-xs text-muted-foreground">
              @{user.displayUsername ?? user.username}
            </span>
          </span>
          <ChevronsUpDownIcon className="ml-auto size-4 text-muted-foreground" aria-hidden="true" />
        </SidebarMenuButton>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        side={isMobile ? 'top' : 'right'}
        align="end"
        sideOffset={8}
        className="w-60"
      >
        <DropdownMenuLabel className="font-normal">
          <span className="block truncate text-sm font-medium">{user.name}</span>
          <span className="block truncate text-xs text-muted-foreground">{user.email}</span>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <Link to="/settings" onClick={() => setOpenMobile(false)}>
            <SettingsIcon aria-hidden="true" />
            Settings
          </Link>
        </DropdownMenuItem>
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>
            <ThemeIcon className="size-4 text-muted-foreground" aria-hidden="true" />
            Theme
            <span className="ml-auto pl-2 text-xs text-muted-foreground">
              {THEME_OPTIONS[theme].label}
            </span>
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent>
            <DropdownMenuRadioGroup
              value={theme}
              onValueChange={(value) => {
                if (isTheme(value)) setTheme(value);
              }}
            >
              {THEMES.map((option) => {
                const { label, icon: Icon } = THEME_OPTIONS[option];
                return (
                  <DropdownMenuRadioItem key={option} value={option}>
                    <Icon aria-hidden="true" />
                    {label}
                  </DropdownMenuRadioItem>
                );
              })}
            </DropdownMenuRadioGroup>
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        <DropdownMenuItem onSelect={() => setShortcutsHelpOpen(true)}>
          <KeyboardIcon aria-hidden="true" />
          Keyboard shortcuts
          <DropdownMenuShortcut>?</DropdownMenuShortcut>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => void signOut()}>
          <LogOutIcon aria-hidden="true" />
          Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
