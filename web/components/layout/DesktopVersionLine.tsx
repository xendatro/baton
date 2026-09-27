import type { DesktopState } from '@shared/desktopBridge';
import { desktopVersionText } from '@shared/desktopVersion';
import { useConfig } from '@web/lib/auth';
import { WEB_COMMIT } from '@web/lib/buildInfo';

/**
 * Which builds are running (BAT-31), under the sidebar's "This computer": the desktop app's
 * version and commit with the latest release ("Baton desktop 0.3.0 (abc1234) · Latest: 0.3.1"),
 * and the web app's version and commit that the window has loaded.
 */
export function DesktopVersionLine({ state }: { state: DesktopState | null }) {
  const config = useConfig();
  if (!state) return null;
  const { installed, latest } = desktopVersionText(state);
  const webVersion = config.data?.version;
  return (
    <div
      className="grid gap-0.5 px-2 pt-1 pb-2 text-[11px] leading-snug text-muted-foreground group-data-[collapsible=icon]:hidden"
      data-testid="desktop-versions"
    >
      <p>
        {installed}
        {latest ? ` · ${latest}` : null}
      </p>
      <p>
        Web {webVersion ? `${webVersion} ` : ''}({WEB_COMMIT})
      </p>
    </div>
  );
}
