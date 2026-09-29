import { CheckCircle2Icon, HourglassIcon, XCircleIcon } from 'lucide-react';
import type { ItemAgentRequestStatus } from '@shared/schemas/agentAccess';
import { HARNESS_LABELS, type ChainEntry } from '@shared/schemas/agentRunner';
import { useSession } from '@web/lib/auth';
import { cn } from '@web/lib/utils';
import { AgentRequestCard } from './AgentRequestCard';
import { useAgentRequestsFor } from './queries';

/**
 * Requests about one task or issue, for a conversation: its owner gets full cards with Approve /
 * Decline (`AgentRequestCard compact`), everyone else a one-line status ("Ethan AI is waiting for
 * Ethan’s OK", "Ethan approved (Claude Code · opus · high)", "Ethan declined: …"), live. With
 * `replyId`, only the requests that message made (a chat or forum shows them right under it);
 * `null`, those no message made (an @mention in the description, an assignment). Renders nothing
 * when there are none.
 */
export function ItemAgentRequests({
  item,
  replyId,
  className,
}: {
  item: { type: 'task' | 'issue'; id: string };
  /** Only the requests of this message (`null`: of no message); all when absent. */
  replyId?: string | null;
  className?: string;
}) {
  const requests = useAgentRequestsFor(item);
  const viewerId = useSession().data?.user.id ?? null;
  if (!requests.data) return null;
  const matches = (id: string | null) => replyId === undefined || id === replyId;
  const mine = requests.data.mine.filter((request) => matches(request.message?.replyId ?? null));
  const mineIds = new Set(requests.data.mine.map((request) => request.jobId));
  const others = requests.data.waiting.filter(
    (entry) => !mineIds.has(entry.jobId) && matches(entry.replyId),
  );
  if (mine.length === 0 && others.length === 0) return null;
  return (
    <div className={cn('grid gap-2', className)} aria-label="Agent requests">
      {mine.map((request) => (
        <AgentRequestCard key={request.jobId} request={request} compact />
      ))}
      {others.map((entry) => (
        <AgentRequestStatusLine
          key={entry.jobId}
          status={entry}
          viewerId={viewerId}
          inline={replyId !== undefined}
        />
      ))}
    </div>
  );
}

function stepText(step: ChainEntry): string {
  return [HARNESS_LABELS[step.harness], step.model || null, step.effort || null]
    .filter(Boolean)
    .join(' · ');
}

/**
 * "Ethan AI is waiting for Ethan’s OK", "Ethan approved (Claude Code · opus · high)" or "Ethan
 * declined: …". `inline` (under the message that asked) leaves out what it was about.
 */
export function AgentRequestStatusLine({
  status,
  viewerId = null,
  inline = false,
}: {
  status: ItemAgentRequestStatus;
  viewerId?: string | null;
  inline?: boolean;
}) {
  const owner = viewerId !== null && status.owner.id === viewerId ? 'You' : status.owner.name;
  const about = inline ? '' : `: ${status.summary}`;
  if (status.status === 'declined') {
    return (
      <p
        className="flex items-start gap-1.5 text-xs text-muted-foreground"
        role="status"
        data-testid="agent-request-line"
      >
        <XCircleIcon className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
        <span>
          {owner} declined{inline ? (status.reason ? ':' : '') : about}
          {status.reason ? (inline ? ` ${status.reason}` : ` — “${status.reason}”`) : ''}
        </span>
      </p>
    );
  }
  if (status.status === 'approved') {
    return (
      <p
        className="flex items-start gap-1.5 text-xs text-muted-foreground"
        role="status"
        data-testid="agent-request-line"
      >
        <CheckCircle2Icon className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
        <span>
          {owner} approved{inline ? '' : ` ${status.agent.name}${about}`}
          {status.model ? ` (${stepText(status.model)})` : ''}
        </span>
      </p>
    );
  }
  return (
    <p
      className="flex items-start gap-1.5 text-xs text-muted-foreground"
      role="status"
      data-testid="agent-request-line"
    >
      <HourglassIcon className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
      <span>
        {status.agent.name} is waiting for {owner === 'You' ? 'your' : `${owner}’s`} OK{about}
      </span>
    </p>
  );
}
