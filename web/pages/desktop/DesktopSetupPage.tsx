import { CheckCircle2Icon, CircleIcon } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { toast } from 'sonner';
import { Spinner } from '@web/components/common/Spinner';
import { PageContainer } from '@web/components/common/PageContainer';
import { PageHeader } from '@web/components/common/PageHeader';
import { Button } from '@web/components/ui/button';
import { errorMessage } from '@web/lib/api';
import { desktopBridge, useDesktopState } from '@web/lib/desktop';
import { useDocumentTitle } from '@web/lib/title';
import { useCreateApiKey } from '../settings/queries';
import { DesktopOnly } from './common';
import { HarnessList } from './DesktopHarnessesPage';

/**
 * `/desktop/setup`: setting up this computer to run your agent's jobs (BAT-26). You're already
 * signed in; "Run my agent here" makes this computer's agent key itself. Then folders,
 * permissions, models and whose jobs run, and a test run.
 */
export default function DesktopSetupPage() {
  useDocumentTitle(['Set up this computer']);
  return (
    <DesktopOnly>
      <Setup />
    </DesktopOnly>
  );
}

function Step({
  number,
  done,
  title,
  children,
}: {
  number: number;
  /** null: an optional step, with no done state. */
  done: boolean | null;
  title: string;
  children: ReactNode;
}) {
  return (
    <li className="rounded-lg border bg-card p-4">
      <h2 className="flex items-center gap-2 font-medium">
        {done ? (
          <CheckCircle2Icon className="size-5 text-primary" aria-label="Done" />
        ) : done === false ? (
          <CircleIcon className="size-5 text-muted-foreground" aria-label="To do" />
        ) : (
          <CircleIcon className="size-5 text-muted-foreground/40" aria-label="Optional" />
        )}
        {number}. {title}
        {done === null ? (
          <span className="text-xs font-normal text-muted-foreground">Optional</span>
        ) : null}
      </h2>
      <div className="mt-2 grid gap-2 pl-7 text-sm">{children}</div>
    </li>
  );
}

function Setup() {
  const { state } = useDesktopState();
  const createKey = useCreateApiKey();
  const [connecting, setConnecting] = useState(false);
  const folderCount = Object.keys(state?.folders ?? {}).length;
  const testedCount = state?.testedHarnesses?.length ?? 0;
  const required = [Boolean(state?.connected), folderCount > 0, testedCount > 0];
  const doneCount = required.filter(Boolean).length;

  const connect = async () => {
    setConnecting(true);
    try {
      const created = await createKey.mutateAsync({
        name: `Desktop · ${state?.machineName ?? 'this computer'}`.slice(0, 60),
      });
      await desktopBridge()?.connect(created.key);
      toast.success('Your agent runs on this computer now');
    } catch (cause) {
      toast.error(errorMessage(cause));
    } finally {
      setConnecting(false);
    }
  };

  return (
    <PageContainer>
      <PageHeader
        title="Set up this computer"
        description="Your agent listens for its jobs here without spending tokens, and runs each one in your own harness, in the folder you pick for its project."
      />
      <p className="mb-4 text-sm text-muted-foreground" aria-live="polite">
        {doneCount === required.length
          ? 'All set: this computer runs your agent’s jobs. Come back here any time to change it.'
          : `${doneCount} of ${required.length} steps done.`}
      </p>
      <ol className="grid max-w-3xl gap-3">
        <Step number={1} done={Boolean(state?.connected)} title="Run my agent on this computer">
          {state?.connected ? (
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-muted-foreground">
                Connected as “{state.machineName}”. Its key is in Settings → API keys.
              </span>
              <Button size="sm" variant="ghost" onClick={() => void desktopBridge()?.disconnect()}>
                Stop running it here
              </Button>
            </div>
          ) : (
            <>
              <p className="text-muted-foreground">
                This creates an API key for this computer (you’ll see it in Settings → API keys) and
                starts listening for your agent’s jobs.
              </p>
              <Button
                className="justify-self-start"
                onClick={() => void connect()}
                disabled={connecting}
              >
                {connecting ? <Spinner /> : null}
                Run my agent here
              </Button>
            </>
          )}
        </Step>
        <Step number={2} done={folderCount > 0} title="Pick folders for your projects">
          <p className="text-muted-foreground">
            {folderCount > 0
              ? `${folderCount} project${folderCount === 1 ? '' : 's'} set.`
              : 'Jobs only run here for projects you add. Pick a folder (usually its repository), or “No folder” to let the app make a scratch folder.'}
          </p>
          <Button asChild size="sm" variant="outline" className="justify-self-start">
            <Link to="/desktop/folders">Choose folders</Link>
          </Button>
        </Step>
        <Step number={3} done={testedCount > 0} title="Pick permissions and run a test">
          <p className="text-muted-foreground">
            Done once a test run works for one of your harnesses.
          </p>
          <HarnessList installedOnly />
        </Step>
        <Step number={4} done={null} title="Models and whose jobs run">
          <p className="text-muted-foreground">
            Pick your agent’s default model (and per project, if you like), and whether other
            people’s mentions run by themselves or wait for your OK.
          </p>
          <Button asChild size="sm" variant="outline" className="justify-self-start">
            <Link to="/settings/automatic-agents">Open Automatic agents</Link>
          </Button>
        </Step>
        <Step number={5} done={null} title="Watch it work">
          <p className="text-muted-foreground">
            Mention or assign your agent on a task: the job shows up in Running agents.
          </p>
          <Button asChild size="sm" className="justify-self-start">
            <Link to="/desktop">Running agents</Link>
          </Button>
        </Step>
      </ol>
    </PageContainer>
  );
}
