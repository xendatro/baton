import { DownloadIcon, RefreshCwIcon } from 'lucide-react';
import type { DesktopUpdate } from '@shared/desktopBridge';
import { Button } from '@web/components/ui/button';
import { desktopBridge } from '@web/lib/desktop';

/**
 * A new version of the desktop app (its own code: the runner, harnesses, tray). Shown in the
 * sidebar while one is downloading or ready: "Restart to update" installs it in place (Windows,
 * Linux); on macOS "Download" opens the new version, installed over the old one.
 */
export function DesktopUpdateNotice({ update }: { update: DesktopUpdate | undefined }) {
  if (!update) return null;
  const { status, version, progress, manual } = update;
  if (status !== 'ready' && status !== 'available' && status !== 'downloading') return null;
  const install = () => void desktopBridge()?.installUpdate?.();
  return (
    <div
      role="status"
      className="mx-2 mb-2 grid gap-2 rounded-md border bg-card p-3 text-sm"
      aria-label="Desktop app update"
    >
      <p className="font-medium">Baton {version ?? ''} is available</p>
      {status === 'downloading' ? (
        <p className="text-xs text-muted-foreground">Downloading… {progress ?? 0}%</p>
      ) : status === 'ready' ? (
        <>
          <p className="text-xs text-muted-foreground">
            It installs when you restart (or the next time you quit).
          </p>
          <Button size="sm" onClick={install}>
            <RefreshCwIcon aria-hidden="true" />
            Restart to update
          </Button>
        </>
      ) : (
        <>
          <p className="text-xs text-muted-foreground">
            {manual
              ? 'Download it and install it over this one; your settings stay.'
              : 'It will download in the background.'}
          </p>
          {manual ? (
            <Button size="sm" onClick={install}>
              <DownloadIcon aria-hidden="true" />
              Download
            </Button>
          ) : null}
        </>
      )}
    </div>
  );
}
