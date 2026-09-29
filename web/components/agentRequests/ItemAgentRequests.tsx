import { HourglassIcon, XCircleIcon } from 'lucide-react';
import type { ItemAgentRequestStatus } from '@shared/schemas/agentAccess';
import { cn } from '@web/lib/utils';
import { AgentRequestCard } from './AgentRequestCard';
import { useAgentRequestsFor } from './queries';

/**
 * Requests about one task or issue, for a conversation: its owner gets full cards with Approve /
 * Decline (`AgentRequestCard compact`), everyone else a one-line status ("Ethan AI is waiting for
 * Ethan’s OK: Reply to Caden’s message on BAT-40", "Ethan declined: …"). Renders nothing when
 * there are none.
 */
export function ItemAgentRequests({
  item,
  className,
}: {
  item: { type: 'task' | 'issue'; id: string };
  className?: string;
}) {
  const requests = useAgentRequestsFor(item);
  if (!requests.data) return null;
  const mine = new Set(requests.data.mine.map((request) => request.jobId));
  const others = requests.data.waiting.filter((entry) => !mine.has(entry.jobId));
  if (mine.size === 0 && others.length === 0) return null;
  return (
    <div className={cn('grid gap-2', className)} aria-label="Agent requests">
      {requests.data.mine.map((request) => (
        <AgentRequestCard key={request.jobId} request={request} compact />
      ))}
      {others.map((entry) => (
        <AgentRequestStatusLine key={entry.jobId} status={entry} />
      ))}
    </div>
  );
}

/** "Ethan AI is waiting for Ethan’s OK: …" or "Ethan declined Ethan AI’s request: …". */
export function AgentRequestStatusLine({ status }: { status: ItemAgentRequestStatus }) {
  if (status.status === 'declined') {
    return (
      <p className="flex items-start gap-1.5 text-xs text-muted-foreground" role="status">
        <XCircleIcon className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
        <span>
          {status.owner.name} declined: {status.summary}
          {status.reason ? ` — “${status.reason}”` : ''}
        </span>
      </p>
    );
  }
  return (
    <p className="flex items-start gap-1.5 text-xs text-muted-foreground" role="status">
      <HourglassIcon className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
      <span>
        {status.agent.name} is waiting for {status.owner.name}’s OK: {status.summary}
      </span>
    </p>
  );
}
