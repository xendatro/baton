import { DownloadIcon, GaugeIcon, MonitorIcon } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { toast } from 'sonner';
import { HARNESS_LABELS, type HarnessId } from '@shared/schemas/agentRunner';
import { EmptyState } from '@web/components/common/EmptyState';
import { PageContainer } from '@web/components/common/PageContainer';
import { Button } from '@web/components/ui/button';
import { errorMessage } from '@web/lib/api';
import { desktopBridge, usageClock } from '@web/lib/desktop';

/**
 * BAT#30: "Out of usage until 01:00 (Codex)" with Clear usage limit, which forgets the limit this
 * computer stored for the harness (jobs waiting on it try again at once).
 */
export function UsageLimit({ harness, until }: { harness: HarnessId; until: number }) {
  const bridge = desktopBridge();
  const [clearing, setClearing] = useState(false);
  const clear = () => {
    setClearing(true);
    bridge
      ?.clearUsageLimit?.(harness)
      .then(
        () => toast.success(`Usage limit of ${HARNESS_LABELS[harness]} cleared`),
        (cause: unknown) => toast.error(errorMessage(cause)),
      )
      .finally(() => setClearing(false));
  };
  return (
    <div className="flex flex-wrap items-center gap-2 text-sm">
      <GaugeIcon aria-hidden="true" className="size-4 text-amber-600 dark:text-amber-400" />
      <span>
        Out of usage until {usageClock(until)} ({HARNESS_LABELS[harness]})
      </span>
      {bridge?.clearUsageLimit ? (
        <Button size="sm" variant="outline" onClick={clear} disabled={clearing}>
          Clear usage limit
        </Button>
      ) : null}
    </div>
  );
}

/**
 * Desktop pages (BAT-26) only work inside the Baton desktop app. In a browser they say so and
 * point to the download.
 */
export function DesktopOnly({ children }: { children: ReactNode }) {
  if (desktopBridge()) return <>{children}</>;
  return (
    <PageContainer>
      <EmptyState
        icon={MonitorIcon}
        title="This page is part of the desktop app"
        description="The Baton desktop app runs your agent’s jobs on your computer. Everything else in Baton works the same in both."
        action={
          <Button asChild>
            <Link to="/download">
              <DownloadIcon aria-hidden="true" />
              Get the desktop app
            </Link>
          </Button>
        }
        className="py-16"
      />
    </PageContainer>
  );
}
