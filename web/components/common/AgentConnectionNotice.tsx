import { useQueryClient } from '@tanstack/react-query';
import {
  CircleCheckIcon,
  DownloadIcon,
  FolderOpenIcon,
  PauseIcon,
  PlayIcon,
  PlugZapIcon,
  XIcon,
} from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router';
import { toast } from 'sonner';
import type { AgentConnection } from '@shared/schemas/agentRunner';
import { Button } from '@web/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@web/components/ui/dialog';
import { Skeleton } from '@web/components/ui/skeleton';
import {
  agentConnectionProblem,
  useAgentConnection,
  type AgentConnectionProblem,
} from '@web/lib/agentConnection';
import { api, errorMessage } from '@web/lib/api';
import { desktopBridge, useDesktopState } from '@web/lib/desktop';
import { queryKeys } from '@web/lib/queryKeys';
import { cn } from '@web/lib/utils';
import { Spinner } from './Spinner';

/**
 * "Your agent isn't connected to this project" (BAT-24 follow-up): the desktop runner only takes
 * the jobs of projects mapped to a folder on its computer, and an MCP listener only those of the
 * projects it listens to; otherwise the agent's jobs wait forever, silently. Shown wherever the
 * viewer involves their agent, with Connect now: in the desktop app the folder picker (or its
 * setup when this computer isn't connected), in a browser a dialog pointing to the app.
 */

/** Dismissed notices (placement + project), for this page load only: they come back on reload. */
const dismissed = new Set<string>();

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? '' : 's'}`;
}

/** "Connect now": the folder picker in the desktop app, the explanation dialog in a browser. */
function useConnectAgent(connection: AgentConnection | undefined) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { state } = useDesktopState();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const bridge = desktopBridge();
  const project = connection?.project;
  const label = project ? `${project.ref} — ${project.name}` : '';
  const refresh = () =>
    queryClient.invalidateQueries({ queryKey: queryKeys.account.agentConnection() });

  const connect = async () => {
    if (!project) return;
    if (!bridge) {
      setDialogOpen(true);
      return;
    }
    const desktop = state ?? (await bridge.state());
    if (!desktop.connected) {
      void navigate('/desktop/setup');
      return;
    }
    if (desktop.folders[project.id]) {
      // Mapped here already: the app itself isn't taking jobs (paused here or offline).
      void navigate('/desktop');
      return;
    }
    setPending(true);
    try {
      const check = await bridge.pickFolder(project.id, label, project.repoUrl);
      if (check) {
        if (check.state === 'mismatch') {
          toast.warning(`Folder set, but its repository is ${check.remote}, not ${check.expected}`);
        } else {
          toast.success(`Your agent now takes ${project.name}’s jobs on this computer`);
        }
      }
    } catch (cause) {
      toast.error(errorMessage(cause));
    } finally {
      setPending(false);
      void refresh();
    }
  };

  const noFolder = async () => {
    if (!project || !bridge) return;
    setPending(true);
    try {
      await bridge.useScratch(project.id, label);
      toast.success(`Your agent now takes ${project.name}’s jobs on this computer (no folder)`);
    } catch (cause) {
      toast.error(errorMessage(cause));
    } finally {
      setPending(false);
      void refresh();
    }
  };

  return {
    connect,
    noFolder,
    pending,
    inDesktop: bridge !== null,
    /** The desktop app is connected here, so "No folder" can map the project at once. */
    canUseScratch: bridge !== null && Boolean(state?.connected),
    dialog: project ? (
      <ConnectDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        projectRef={project.ref}
        projectName={project.name}
      />
    ) : null,
  };
}

function ConnectDialog({
  open,
  onOpenChange,
  projectRef,
  projectName,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectRef: string;
  projectName: string;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Connect your agent to {projectName}</DialogTitle>
          <DialogDescription>
            Your agent runs its jobs from the Baton desktop app on your computer, in a folder you
            choose for each project (usually its repository).
          </DialogDescription>
        </DialogHeader>
        <ol className="list-decimal space-y-2 pl-5 text-sm">
          <li>
            <Link
              to="/download"
              className="font-medium text-primary underline-offset-4 hover:underline"
            >
              Download the desktop app
            </Link>{' '}
            and sign in to this server.
          </li>
          <li>
            Already installed? Open it → <strong>This computer → Folders</strong> →{' '}
            <strong>{projectRef}</strong> → Choose folder.
          </li>
        </ol>
        <p className="text-sm text-muted-foreground">
          Or with your own MCP client: call{' '}
          <code className="rounded bg-muted px-1 py-0.5 text-xs">
            start_listener {`{ projects: ["${projectRef}"] }`}
          </code>{' '}
          and keep it running.
        </p>
        <DialogFooter>
          <Button asChild>
            <Link to="/download">
              <DownloadIcon aria-hidden="true" />
              Get the desktop app
            </Link>
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function useResumeAgent() {
  const queryClient = useQueryClient();
  const [pending, setPending] = useState(false);
  const resume = async () => {
    setPending(true);
    try {
      await api.patch('/api/me/agent', { paused: false });
      toast.success('Your agent is back at work');
    } catch (cause) {
      toast.error(errorMessage(cause));
    } finally {
      setPending(false);
      void queryClient.invalidateQueries({ queryKey: queryKeys.account.agent() });
    }
  };
  return { resume, pending };
}

/** The words of a problem: title and detail. */
function problemText(
  problem: AgentConnectionProblem,
  connection: AgentConnection,
  waitingNote: string | null,
): { title: string; detail: string } {
  const name = connection.project.name;
  switch (problem.kind) {
    case 'paused':
      return { title: 'Your agent is paused', detail: problem.reason };
    case 'no_access':
      return {
        title: `Your agent can’t see ${name}`,
        detail: 'It gets no jobs here. Give it access in the project’s settings.',
      };
    case 'not_connected': {
      const offline = connection.runners.find((runner) => !runner.online && runner.coversProject);
      const where =
        problem.elsewhere.length > 0
          ? `Baton on ${problem.elsewhere.join(', ')} doesn’t take this project’s jobs yet.`
          : offline
            ? `Baton on ${offline.machineName} takes them, but it isn’t running.`
            : 'No computer of yours takes this project’s jobs.';
      return {
        title: `Your agent isn’t connected to ${name} — AI jobs here won’t run.`,
        detail: [waitingNote, where].filter(Boolean).join(' '),
      };
    }
  }
}

export interface AgentConnectionNoticeProps {
  projectId: string;
  taskId?: string;
  /** `banner`: top of a page; `inline`: a compact line (under the reply box). */
  variant?: 'banner' | 'inline';
  /** Whether the connection matters here (e.g. the task involves the agent). Default: always. */
  when?: (connection: AgentConnection) => boolean;
  /** Dismissible for this page load under this key (it comes back on reload). */
  dismissKey?: string;
  /** Leads the detail ("3 jobs waiting for your agent."); default: the pending count. */
  waitingNote?: (connection: AgentConnection) => string | null;
  className?: string;
}

/** The amber "not connected / paused" notice with Connect now or Resume; nothing when all good. */
export function AgentConnectionNotice({
  projectId,
  taskId,
  variant = 'banner',
  when,
  dismissKey,
  waitingNote,
  className,
}: AgentConnectionNoticeProps) {
  const query = useAgentConnection(projectId, taskId);
  const connection = query.data;
  const connect = useConnectAgent(connection);
  const resume = useResumeAgent();
  const key = dismissKey ? `${dismissKey}:${projectId}` : null;
  const [hidden, setHidden] = useState(() => (key ? dismissed.has(key) : false));
  const problem = agentConnectionProblem(connection);
  if (!connection || !problem || hidden) return connect.dialog;
  if (when && !when(connection)) return connect.dialog;

  const note =
    waitingNote?.(connection) ??
    (connection.pendingJobs > 0
      ? `${plural(connection.pendingJobs, 'job')} waiting for your agent.`
      : null);
  const text = problemText(problem, connection, note);
  const inline = variant === 'inline';
  const Icon = problem.kind === 'paused' ? PauseIcon : PlugZapIcon;

  let actions: ReactNode = null;
  if (problem.kind === 'paused' && problem.canResume) {
    actions = (
      <Button size="sm" onClick={() => void resume.resume()} disabled={resume.pending}>
        {resume.pending ? <Spinner /> : <PlayIcon aria-hidden="true" />}
        Resume
      </Button>
    );
  } else if (problem.kind === 'not_connected') {
    actions = (
      <>
        <Button size="sm" onClick={() => void connect.connect()} disabled={connect.pending}>
          {connect.pending ? <Spinner /> : <PlugZapIcon aria-hidden="true" />}
          Connect now
        </Button>
        {connect.canUseScratch ? (
          <Button
            size="sm"
            variant="outline"
            onClick={() => void connect.noFolder()}
            disabled={connect.pending}
          >
            No folder
          </Button>
        ) : null}
        {connect.inDesktop && !inline ? (
          <Button asChild size="sm" variant="ghost">
            <Link to="/desktop/folders">
              <FolderOpenIcon aria-hidden="true" />
              Folders
            </Link>
          </Button>
        ) : null}
      </>
    );
  }

  return (
    <div
      role="alert"
      data-testid="agent-connection-notice"
      className={cn(
        'flex flex-wrap items-start gap-3 rounded-lg border border-amber-500/50 bg-amber-500/10 text-sm',
        inline ? 'px-3 py-2' : 'px-4 py-3',
        className,
      )}
    >
      <Icon
        className="mt-0.5 size-4 shrink-0 text-amber-600 dark:text-amber-400"
        aria-hidden="true"
      />
      <div className="min-w-0 flex-1 basis-60">
        <p className="font-medium">{text.title}</p>
        {text.detail ? <p className="text-muted-foreground">{text.detail}</p> : null}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {actions}
        {key ? (
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label="Dismiss for now"
            onClick={() => {
              dismissed.add(key);
              setHidden(true);
            }}
          >
            <XIcon aria-hidden="true" />
          </Button>
        ) : null}
      </div>
      {connect.dialog}
    </div>
  );
}

/**
 * The project's "Your settings" section: the agent's connection here, always shown (connected on
 * which machines, or what is missing, with Connect now).
 */
export function AgentConnectionStatus({ projectId }: { projectId: string }) {
  const query = useAgentConnection(projectId);
  const connection = query.data;
  if (query.isPending) return <Skeleton className="h-14 rounded-lg" />;
  if (query.isError || !connection) {
    return (
      <p role="alert" className="text-sm text-destructive">
        {errorMessage(query.error)}
      </p>
    );
  }
  if (!connection.agent) {
    return <p className="text-sm text-muted-foreground">You don’t have an agent yet.</p>;
  }
  const problem = agentConnectionProblem(connection);
  if (problem) return <AgentConnectionNotice projectId={projectId} />;
  const machines = connection.runners
    .filter((runner) => runner.online && runner.coversProject)
    .map((runner) => runner.machineName);
  const where = [
    ...(machines.length > 0 ? [`Baton on ${machines.join(', ')}`] : []),
    ...(connection.listening ? ['an MCP listener'] : []),
  ].join(' and ');
  return (
    <p className="flex items-center gap-2 text-sm" data-testid="agent-connection-ok">
      <CircleCheckIcon
        className="size-4 text-emerald-600 dark:text-emerald-400"
        aria-hidden="true"
      />
      <span>
        Connected: your agent’s jobs here run on {where}.
        {connection.pendingJobs > 0
          ? ` ${plural(connection.pendingJobs, 'job')} waiting to be picked up.`
          : ''}
      </span>
    </p>
  );
}
