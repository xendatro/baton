import { PlayIcon } from 'lucide-react';
import { useEffect, useId, useState } from 'react';
import { Link } from 'react-router';
import { toast } from 'sonner';
import type { DesktopHarness, DesktopTestResult } from '@shared/desktopBridge';
import { Spinner } from '@web/components/common/Spinner';
import { PageContainer } from '@web/components/common/PageContainer';
import { PageHeader } from '@web/components/common/PageHeader';
import { useNow } from '@web/components/common/useNow';
import { Badge } from '@web/components/ui/badge';
import { Button } from '@web/components/ui/button';
import { Label } from '@web/components/ui/label';
import { Skeleton } from '@web/components/ui/skeleton';
import { errorMessage } from '@web/lib/api';
import { desktopBridge, useDesktopState } from '@web/lib/desktop';
import { useDocumentTitle } from '@web/lib/title';
import { DesktopOnly, UsageLimit } from './common';

/**
 * `/desktop/harnesses`: the coding agents installed on this computer (BAT-26) and how each one
 * handles permission prompts when nobody is at the keyboard, with a test run.
 */
export default function DesktopHarnessesPage() {
  useDocumentTitle(['Harnesses']);
  return (
    <DesktopOnly>
      <PageContainer>
        <PageHeader
          title="Harnesses"
          description="Headless sessions can’t show permission prompts, so choose how each harness handles them. Your own settings, skills, plugins and MCP servers are used as they are."
        />
        <HarnessList />
      </PageContainer>
    </DesktopOnly>
  );
}

function useHarnesses() {
  const [harnesses, setHarnesses] = useState<DesktopHarness[] | null>(null);
  useEffect(() => {
    void desktopBridge()?.harnesses().then(setHarnesses);
  }, []);
  return harnesses;
}

export function HarnessList({ installedOnly = false }: { installedOnly?: boolean }) {
  const harnesses = useHarnesses();
  if (!harnesses) {
    return (
      <div className="grid gap-3" role="status" aria-label="Looking for harnesses">
        <Skeleton className="h-24 rounded-lg" />
        <Skeleton className="h-24 rounded-lg" />
      </div>
    );
  }
  const shown = installedOnly ? harnesses.filter((harness) => harness.installed) : harnesses;
  return (
    <ul className="grid gap-3" aria-label="Harnesses">
      {shown.map((harness) => (
        <HarnessCard key={harness.id} harness={harness} />
      ))}
    </ul>
  );
}

function HarnessCard({ harness }: { harness: DesktopHarness }) {
  const selectId = useId();
  const { state } = useDesktopState();
  // A test run uses this computer's agent key, so it needs step 1 of the setup first.
  const connected = Boolean(state?.connected);
  const tested = state?.testedHarnesses?.includes(harness.id) ?? false;
  const now = useNow();
  // BAT#30: out of usage here, with Clear usage limit.
  const exhaustedUntil = state?.exhaustedUntil?.[harness.id];
  const [mode, setMode] = useState(harness.mode ?? '');
  const [testing, setTesting] = useState(false);
  const [test, setTest] = useState<DesktopTestResult | null>(null);
  const description = harness.modes.find((item) => item.id === mode)?.description;
  const runTest = () => {
    setTesting(true);
    setTest(null);
    desktopBridge()
      ?.testRun(harness.id)
      .then(setTest, (cause: unknown) => toast.error(errorMessage(cause)))
      .finally(() => setTesting(false));
  };
  return (
    <li className="rounded-lg border bg-card p-4" aria-label={harness.label}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="font-medium">{harness.label}</p>
          <p className="truncate text-sm text-muted-foreground">
            {harness.installed
              ? `${harness.path ?? ''}${harness.version ? ` · ${harness.version}` : ''} · runs as “${harness.headless}”`
              : 'Not installed on this computer'}
          </p>
        </div>
        <Badge variant={harness.installed ? 'default' : 'outline'}>
          {harness.installed ? 'Installed' : 'Not found'}
        </Badge>
      </div>
      {harness.installed ? (
        <div className="mt-3 grid gap-2">
          {exhaustedUntil && exhaustedUntil > now ? (
            <UsageLimit harness={harness.id} until={exhaustedUntil} />
          ) : null}
          <div className="flex flex-wrap items-center gap-2">
            <Label htmlFor={selectId}>Permissions</Label>
            <select
              id={selectId}
              value={mode}
              onChange={(event) => {
                setMode(event.target.value);
                void desktopBridge()
                  ?.setPermissionMode(harness.id, event.target.value)
                  .then(() => toast.success(`Saved for ${harness.label}`));
              }}
              className="h-8 rounded-md border border-input bg-transparent px-2 text-sm dark:bg-input/30"
            >
              {harness.modes.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.label}
                  {item.unattended ? '' : ' (you approve in pop-ups)'}
                </option>
              ))}
            </select>
          </div>
          {description ? <p className="text-sm text-muted-foreground">{description}</p> : null}
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" variant="outline" onClick={runTest} disabled={testing || !connected}>
              {testing ? <Spinner /> : <PlayIcon aria-hidden="true" />}
              Run a test
            </Button>
            {!connected ? (
              <span className="text-sm text-muted-foreground">
                First connect this computer:{' '}
                <Link to="/desktop/setup" className="underline">
                  Set up this computer
                </Link>{' '}
                → Run my agent here.
              </span>
            ) : tested && !test ? (
              <span className="text-sm text-muted-foreground">Tested: it works.</span>
            ) : null}
          </div>
          {test ? (
            <pre
              className="max-h-48 overflow-auto rounded-md bg-zinc-950 p-3 text-xs whitespace-pre-wrap text-zinc-100"
              aria-label={`${harness.label} test output`}
            >
              {test.ok ? '✓ Works' : `✗ ${test.outcome}`}
              {'\n'}
              {test.output}
            </pre>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}
