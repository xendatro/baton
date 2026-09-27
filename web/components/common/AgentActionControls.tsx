import { BanIcon, CheckIcon, CircleAlertIcon, ClockIcon, XIcon } from 'lucide-react';
import { toast } from 'sonner';
import type { AgentActionRequest } from '@shared/schemas/agentActions';
import { Button } from '@web/components/ui/button';
import {
  AGENT_ACTION_STATUS_LABELS,
  requestSentence,
  useDecideAgentAction,
  type AgentActionDecision,
} from '@web/lib/agentActions';
import { errorMessage } from '@web/lib/api';
import { cn } from '@web/lib/utils';
import { Spinner } from './Spinner';

export interface AgentActionControlsProps {
  request: AgentActionRequest;
  className?: string;
}

/**
 * Approve / Deny for a pending agent sign-off request (design §6), or what became of it. Used by
 * inbox rows and Settings → Agent. Approving runs the action at once.
 */
export function AgentActionControls({ request, className }: AgentActionControlsProps) {
  const decide = useDecideAgentAction();
  const sentence = requestSentence(request);
  const deciding = decide.isPending ? decide.variables.decision : null;

  const run = (decision: AgentActionDecision) =>
    decide.mutate(
      { id: request.id, decision },
      {
        onSuccess: (settled) => {
          if (settled.status === 'approved') toast.success(`Approved: ${settled.summary}`);
          else if (settled.status === 'denied') toast.success(`Denied: ${settled.summary}`);
          else if (settled.status === 'failed') {
            toast.error(`Couldn’t ${settled.summary}`, {
              description: settled.error?.message,
            });
          }
        },
        onError: (error) => toast.error(errorMessage(error)),
      },
    );

  if (request.status !== 'pending')
    return <AgentActionOutcome request={request} className={className} />;

  return (
    <div className={cn('flex flex-wrap items-center gap-2', className)}>
      <Button
        size="sm"
        onClick={() => run('approve')}
        disabled={decide.isPending}
        aria-label={`Approve: ${sentence}`}
      >
        {deciding === 'approve' ? <Spinner className="size-4" /> : <CheckIcon aria-hidden="true" />}
        Approve
      </Button>
      <Button
        size="sm"
        variant="outline"
        onClick={() => run('deny')}
        disabled={decide.isPending}
        aria-label={`Deny: ${sentence}`}
      >
        {deciding === 'deny' ? <Spinner className="size-4" /> : <XIcon aria-hidden="true" />}
        Deny
      </Button>
    </div>
  );
}

const OUTCOME_ICONS = {
  approved: CheckIcon,
  denied: BanIcon,
  expired: ClockIcon,
  failed: CircleAlertIcon,
} as const;

/** What became of a settled request, in words (never color alone). */
export function AgentActionOutcome({ request, className }: AgentActionControlsProps) {
  if (request.status === 'pending') return null;
  const Icon = OUTCOME_ICONS[request.status];
  return (
    <p
      className={cn(
        'inline-flex items-center gap-1.5 text-xs font-medium',
        request.status === 'approved' && 'text-emerald-700 dark:text-emerald-400',
        request.status === 'failed' && 'text-destructive',
        (request.status === 'denied' || request.status === 'expired') && 'text-muted-foreground',
        className,
      )}
      data-testid="agent-action-outcome"
    >
      <Icon className="size-3.5 shrink-0" aria-hidden="true" />
      {AGENT_ACTION_STATUS_LABELS[request.status]}
      {request.status === 'failed' && request.error ? `: ${request.error.message}` : null}
    </p>
  );
}
