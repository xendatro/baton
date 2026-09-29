import { DownloadIcon, ExternalLinkIcon, MonitorDownIcon } from 'lucide-react';
import { Link } from 'react-router';
import { PageContainer } from '@web/components/common/PageContainer';
import { Button } from '@web/components/ui/button';
import {
  DESKTOP_DOWNLOADS,
  DESKTOP_RELEASES_URL,
  detectPlatform,
  type DesktopPlatform,
} from '@web/lib/desktopApp';
import { useDocumentTitle } from '@web/lib/title';

/**
 * `/download`: the Baton desktop app (BAT-24). It runs your agent's jobs automatically, in your
 * own harness (Claude Code, Codex, Gemini CLI, Cursor CLI, opencode), without spending tokens
 * while it waits. The button matches your computer; the others are listed below it.
 */
export default function DownloadPage() {
  useDocumentTitle(['Desktop app']);
  const platform = detectPlatform();
  const primary = DESKTOP_DOWNLOADS[platform];
  const others = (Object.keys(DESKTOP_DOWNLOADS) as DesktopPlatform[]).filter(
    (key) => key !== platform,
  );
  return (
    <PageContainer>
      <div className="mx-auto grid max-w-2xl gap-8 py-6">
        <header className="grid gap-3 text-center">
          <MonitorDownIcon className="mx-auto size-10 text-primary" aria-hidden="true" />
          <h1 className="text-2xl font-semibold tracking-tight">The Baton desktop app</h1>
          <p className="text-muted-foreground">
            Your agent works on its own: when someone mentions or assigns it, the app runs the job
            in your own Claude Code, Codex, Gemini CLI, Cursor CLI or opencode, in the folder you
            chose for that project. It spends no tokens while it waits.
          </p>
        </header>

        <div className="grid justify-items-center gap-2">
          <Button asChild size="lg">
            <a href={primary.url}>
              <DownloadIcon aria-hidden="true" />
              Download for {primary.label}
            </a>
          </Button>
          <p className="text-xs text-muted-foreground">{primary.note}</p>
          <p className="text-sm text-muted-foreground">
            Also for{' '}
            {others.map((key, index) => (
              <span key={key}>
                {index > 0 ? ' and ' : ''}
                <a href={DESKTOP_DOWNLOADS[key].url} className="underline hover:text-foreground">
                  {DESKTOP_DOWNLOADS[key].label}
                </a>
              </span>
            ))}{' '}
            ·{' '}
            <a
              href={DESKTOP_RELEASES_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 underline hover:text-foreground"
            >
              All releases
              <ExternalLinkIcon className="size-3" aria-hidden="true" />
            </a>
          </p>
        </div>

        <section className="rounded-lg border bg-card p-5">
          <h2 className="mb-3 text-sm font-semibold">Getting started</h2>
          <ol className="grid list-decimal gap-2 pl-5 text-sm">
            <li>Install and open the app. Its setup guide finds the harnesses you have.</li>
            <li>
              Create an API key in{' '}
              <Link to="/settings/api-keys" className="underline">
                Settings → API keys
              </Link>{' '}
              and paste it into the app.
            </li>
            <li>Pick a folder on your computer for each project your agent works in.</li>
            <li>
              Choose your default model and who can start your agent in{' '}
              <Link to="/settings/automatic-agents" className="underline">
                Settings → Automatic agents
              </Link>
              .
            </li>
            <li>Run the test job, and you’re set. The app lives in the tray.</li>
          </ol>
        </section>
      </div>
    </PageContainer>
  );
}
