import {
  BellIcon,
  BotIcon,
  KeyRoundIcon,
  LinkIcon,
  PaletteIcon,
  ShieldCheckIcon,
  UserCogIcon,
  UserIcon,
  type LucideIcon,
} from 'lucide-react';

export interface SettingsSection {
  to: string;
  label: string;
  icon: LucideIcon;
  /** Extra words the command palette matches. */
  keywords: string[];
}

/** The account settings pages, in navigation order (SPEC §6 `/settings/*`). */
export const SETTINGS_SECTIONS: readonly SettingsSection[] = [
  {
    to: '/settings/profile',
    label: 'Profile',
    icon: UserIcon,
    keywords: ['avatar', 'name', 'username', 'picture'],
  },
  {
    to: '/settings/account',
    label: 'Account',
    icon: UserCogIcon,
    keywords: ['password', 'email', 'delete account', 'deleted teams', 'restore'],
  },
  {
    to: '/settings/connections',
    label: 'Connections',
    icon: LinkIcon,
    keywords: ['google', 'github', 'link', 'oauth', 'sign-in methods'],
  },
  {
    to: '/settings/api-keys',
    label: 'API keys',
    icon: KeyRoundIcon,
    keywords: ['tokens', 'mcp', 'claude code', 'codex', 'agents'],
  },
  {
    to: '/settings/agent',
    label: 'Agent',
    icon: BotIcon,
    keywords: ['ai', 'pause', 'agent member', 'agent notifications'],
  },
  {
    to: '/settings/appearance',
    label: 'Appearance',
    icon: PaletteIcon,
    keywords: ['theme', 'dark mode', 'light mode'],
  },
  {
    to: '/settings/notifications',
    label: 'Notifications',
    icon: BellIcon,
    keywords: ['desktop notifications', 'sound', 'alerts', 'chime'],
  },
  {
    to: '/settings/security',
    label: 'Security',
    icon: ShieldCheckIcon,
    keywords: ['sessions', 'devices', 'security log'],
  },
];
