import { BotIcon, CircleDotIcon, MessageSquareTextIcon, SparklesIcon, XIcon } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router';
import { toast } from 'sonner';
import type { TaskDraft } from '@shared/schemas/chat';
import { AgentConnectionNotice } from '@web/components/common/AgentConnectionNotice';
import { Spinner } from '@web/components/common/Spinner';
import { MarkdownView } from '@web/components/markdown/MarkdownView';
import { Badge } from '@web/components/ui/badge';
import { Button } from '@web/components/ui/button';
import { agentConnectionProblem, useAgentConnection } from '@web/lib/agentConnection';
import { errorMessage } from '@web/lib/api';
import { pluralize } from '@web/lib/format';
import type { TaskPrefill, TaskPrefillIssue } from '@web/lib/taskPrefill';
import { useRequestTaskDraft, useTaskDraft } from './taskSourceQueries';

/**
 * The New task form's source (Create task on an issue, Make task from this on messages): where it
 * came from, the issue it will be linked to (removable), and "Have my agent draft it": the viewer's
 * own agent writes a title and description from the source (a `draft_task` job) and the draft
 * shows up here, live, to use or discard. Nothing is created until the form is submitted.
 */

export interface TaskSourceBarProps {
  prefill: TaskPrefill;
  projectId: string;
  /** The issue the task will be linked to (null once removed). */
  issue: TaskPrefillIssue | null;
  onRemoveIssue: () => void;
  onUseDraft: (draft: TaskDraft) => void;
}

export function TaskSourceBar({
  prefill,
  projectId,
  issue,
  onRemoveIssue,
  onUseDraft,
}: TaskSourceBarProps) {
  const { source } = prefill;
  const count = source.replyIds.length;
  return (
    <div className="grid gap-2" data-testid="task-source">
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <span className="inline-flex items-center gap-1">
          <MessageSquareTextIcon className="size-3.5" aria-hidden="true" />
          {count > 0
            ? `From ${pluralize(count, 'message')} in ${source.ref}`
            : `From ${source.ref}`}
        </span>
        {issue ? (
          <Badge variant="secondary" className="gap-1 pr-0.5" data-testid="linked-issue">
            <CircleDotIcon aria-hidden="true" />
            {issue.kind === 'fixes' ? 'Fixes' : 'Relates to'} {issue.ref}
            <button
              type="button"
              aria-label={`Don’t link ${issue.ref}`}
              title={`Don’t link ${issue.ref}`}
              onClick={onRemoveIssue}
              className="rounded-sm p-0.5 hover:bg-muted-foreground/20 focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
            >
              <XIcon className="size-3" aria-hidden="true" />
            </button>
          </Badge>
        ) : null}
      </div>
      <AgentDraft source={source} projectId={projectId} onUse={onUseDraft} />
    </div>
  );
}

function AgentDraft({
  source,
  projectId,
  onUse,
}: {
  source: TaskPrefill['source'];
  projectId: string;
  onUse: (draft: TaskDraft) => void;
}) {
  const [jobId, setJobId] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const request = useRequestTaskDraft(source);
  const state = useTaskDraft(jobId);
  const connection = useAgentConnection(
    projectId,
    source.itemType === 'task' ? source.itemId : null,
  );
  const problem = agentConnectionProblem(connection.data);
  const job = state.data;

  const ask = () => {
    setDismissed(false);
    request.mutate(undefined, {
      onSuccess: (next) => setJobId(next.jobId),
      onError: (error) => toast.error(errorMessage(error, 'Couldn’t ask your agent.')),
    });
  };

  if (connection.data && !connection.data.agent) {
    return (
      <p className="text-xs text-muted-foreground">
        <Link to="/settings/agent" className="underline underline-offset-2 hover:text-foreground">
          Set up your agent
        </Link>{' '}
        and it can draft tasks like this for you.
      </p>
    );
  }

  if (job?.draft && !dismissed) {
    return (
      <section
        aria-label="Your agent’s draft"
        className="grid gap-2 rounded-md border border-primary/30 bg-primary/5 p-3"
        data-testid="task-draft"
      >
        <header className="flex items-center gap-1.5 text-xs font-medium text-primary">
          <SparklesIcon className="size-3.5" aria-hidden="true" />
          Your agent’s draft
        </header>
        <p className="text-sm font-medium">{job.draft.title}</p>
        {job.draft.description ? (
          <div className="max-h-48 overflow-y-auto text-sm">
            <MarkdownView markdown={job.draft.description} />
          </div>
        ) : null}
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            size="sm"
            onClick={() => {
              if (job.draft) onUse(job.draft);
              setDismissed(true);
            }}
          >
            Use this draft
          </Button>
          <Button type="button" size="sm" variant="ghost" onClick={() => setDismissed(true)}>
            Discard
          </Button>
        </div>
      </section>
    );
  }

  if (job && (job.status === 'pending' || job.status === 'claimed')) {
    return (
      <p
        role="status"
        className="flex items-center gap-2 rounded-md bg-muted/50 px-3 py-2 text-sm"
        data-testid="task-draft-working"
      >
        <Spinner />
        {job.status === 'claimed'
          ? 'Your agent is drafting the task…'
          : 'Waiting for your agent to pick it up…'}
        <span className="text-xs text-muted-foreground">You can keep editing meanwhile.</span>
      </p>
    );
  }

  return (
    <div className="grid gap-2">
      {problem ? (
        <AgentConnectionNotice
          projectId={projectId}
          taskId={source.itemType === 'task' ? source.itemId : undefined}
          variant="inline"
        />
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={ask}
          disabled={request.isPending || connection.isPending || problem !== null}
        >
          {request.isPending ? <Spinner /> : <BotIcon aria-hidden="true" />}
          Have my agent draft it
        </Button>
        {job?.status === 'cancelled' ? (
          <span className="text-xs text-muted-foreground">Your agent handed it back.</span>
        ) : (
          <span className="text-xs text-muted-foreground">
            Only you see the draft; you review it before creating the task.
          </span>
        )}
      </div>
    </div>
  );
}
