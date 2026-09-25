import { useQueryClient } from '@tanstack/react-query';
import { KeyRoundIcon } from 'lucide-react';
import { useEffect } from 'react';
import { useNavigate } from 'react-router';
import { usePaletteCommands } from '@web/components/palette/registry';
import { useMe, useSession } from '@web/lib/auth';
import { applyStoredTheme, getStoredTheme, useThemePersister } from '@web/lib/theme';
import { saveThemeRequest, setCachedProfile } from './queries';
import { markThemeSession, readThemeSession } from './themeSession';
import { SETTINGS_SECTIONS } from './sections';

/**
 * On the first load of a new sign-in (a session this browser hasn't seen), the theme saved in the
 * profile replaces whatever this browser had, so a theme chosen on one device follows the user to
 * the next. Later loads of the same session keep the local choice (useSyncProfileTheme keeps the
 * two in step while signed in).
 */
function useApplyProfileThemeOnSignIn() {
  const sessionId = useSession().data?.session.id;
  const profileTheme = useMe().data?.user.theme;
  useEffect(() => {
    if (!sessionId || !profileTheme || readThemeSession() === sessionId) return;
    markThemeSession(sessionId);
    if (getStoredTheme() !== profileTheme) applyStoredTheme(profileTheme);
  }, [sessionId, profileTheme]);
}

/**
 * Account module pieces of the signed-in shell (registered in shellExtensions.ts): theme changes
 * are saved to the profile (`PATCH /api/me`), the profile theme is adopted on sign-in, and the
 * settings pages are reachable from the command palette.
 */
export default function AccountShellExtension() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  const sessionId = useSession().data?.session.id;

  // Theme changes from the account menu and the palette; a choice made in this session also
  // settles it, so the profile theme is not adopted over it.
  useThemePersister(async (theme) => {
    if (sessionId) markThemeSession(sessionId);
    setCachedProfile(queryClient, await saveThemeRequest(theme));
  });
  useApplyProfileThemeOnSignIn();

  usePaletteCommands([
    ...SETTINGS_SECTIONS.map((section) => ({
      id: `settings.${section.to}`,
      label: `Settings › ${section.label}`,
      group: 'Settings',
      icon: section.icon,
      keywords: [section.label, 'settings', ...section.keywords],
      perform: () => void navigate(section.to),
    })),
    {
      id: 'settings.api-keys.create',
      label: 'Create an API key',
      group: 'Settings',
      icon: KeyRoundIcon,
      keywords: ['new api key', 'token', 'mcp', 'agent', 'claude code', 'codex'],
      perform: () => void navigate('/settings/api-keys?new=1'),
    },
  ]);

  return null;
}
