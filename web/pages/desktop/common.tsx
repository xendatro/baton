import { DownloadIcon, MonitorIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { EmptyState } from '@web/components/common/EmptyState';
import { PageContainer } from '@web/components/common/PageContainer';
import { Button } from '@web/components/ui/button';
import { desktopBridge } from '@web/lib/desktop';

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
