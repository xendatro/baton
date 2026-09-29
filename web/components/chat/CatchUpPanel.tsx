import { BotIcon, SparklesIcon } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router';
import { toast } from 'sonner';
import { CHAT_LIMITS, type ReplyParentType } from '@shared/constants';
import type { CatchUpRangeInput } from '@shared/schemas/chat';
import { AgentConnectionNotice } from '@web/components/common/AgentConnectionNotice';
import { ErrorState } from '@web/components/common/ErrorState';
import { RelativeTime } from '@web/components/common/RelativeTime';
import { Spinner } from '@web/components/common/Spinner';
import { MarkdownView } from '@web/components/markdown/MarkdownView';
import { Button } from '@web/components/ui/button';
import { Label } from '@web/components/ui/label';
import { RadioGroup, RadioGroupItem } from '@web/components/ui/radio-group';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@web/components/ui/sheet';
import { Skeleton } from '@web/components/ui/skeleton';
import { agentConnectionProblem, useAgentConnection } from '@web/lib/agentConnection';
import { errorMessage } from '@web/lib/api';
import { pluralize } from '@web/lib/format';
import { rangeLabel } from './chatLayout';
import { useCatchUp, useRequestCatchUp } from './queries';

type Choice = 'unread' | `${(typeof CHAT_LIMITS.catchUpCounts)[number]}`;

export interface CatchUpPanelProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  parentType: ReplyParentType;
  parentId: string;
  projectId: string;
  taskId?: string;
  itemRef: string;
  /** The viewer's unread messages when the chat opened, and the first of them. */
  unread: { count: number; firstReplyId: string | null };
}

/**
 * "Catch up": the viewer's own agent summarizes the chat's recent messages for them (unread, or
 * the last 20/50/100). Only ever the viewer's agent: when it isn't connected here, the notice
 * with Connect now shows instead of the button. Summaries are private to the viewer and arrive
 * live (`agent_job.changed`).
 */
export function CatchUpPanel({
  open,
  onOpenChange,
  parentType,
  parentId,
  projectId,
  taskId,
  itemRef,
  unread,
}: CatchUpPanelProps) {
  const state = useCatchUp(parentType, parentId, open);
  const request = useRequestCatchUp(parentType, parentId);
  const connection = useAgentConnection(projectId, taskId, { enabled: open });
  const problem = agentConnectionProblem(connection.data);
  const canUnread = unread.firstReplyId !== null && unread.count > 0;
  // Unread by default when there is something unread (known once the chat has loaded).
  const [picked, setPicked] = useState<Choice | null>(null);
  const choice: Choice = picked ?? (canUnread ? 'unread' : '50');
  const job = state.data?.job ?? null;

  const summarize = () => {
    const range: CatchUpRangeInput =
      choice === 'unread' && unread.firstReplyId
        ? { kind: 'unread', sinceReplyId: unread.firstReplyId }
        : { kind: 'last', count: Number(choice === 'unread' ? 50 : choice) as 20 | 50 | 100 };
    request.mutate(range, {
      onSuccess: () => toast.success('Your agent is catching you up'),
      onError: (error) => toast.error(errorMessage(error, 'Couldn’t ask your agent.')),
    });
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full gap-0 sm:max-w-md" data-testid="catch-up-panel">
        <SheetHeader className="border-b">
          <SheetTitle className="flex items-center gap-2">
            <SparklesIcon className="size-4 text-primary" aria-hidden="true" />
            Catch up
          </SheetTitle>
          <SheetDescription>
            Your own agent reads the chat of {itemRef} and tells you what happened. Only you see the
            summary.
          </SheetDescription>
        </SheetHeader>
        <div className="flex-1 space-y-5 overflow-y-auto p-4">
          {state.isPending ? (
            <div className="space-y-3" role="status" aria-label="Loading">
              <Skeleton className="h-24" />
              <Skeleton className="h-10" />
            </div>
          ) : state.isError ? (
            <ErrorState
              title="Couldn’t load your summaries"
              error={state.error}
              onRetry={() => void state.refetch()}
            />
          ) : !state.data.hasAgent ? (
            <div className="rounded-lg border border-dashed p-4 text-sm">
              <p className="font-medium">You don’t have an agent yet</p>
              <p className="mt-1 text-muted-foreground">
                Connect your AI agent to Baton and it can catch you up on busy chats.
              </p>
              <Button asChild size="sm" className="mt-3">
                <Link to="/settings/agent">
                  <BotIcon aria-hidden="true" />
                  Set up your agent
                </Link>
              </Button>
            </div>
          ) : (
            <section aria-labelledby="catch-up-range" className="space-y-3">
              <h3 id="catch-up-range" className="text-sm font-medium">
                What to summarize
              </h3>
              <RadioGroup
                value={choice}
                onValueChange={(value) => setPicked(value as Choice)}
                className="grid gap-2"
                aria-labelledby="catch-up-range"
              >
                {canUnread ? (
                  <ChoiceRow
                    value="unread"
                    label={`Unread (${pluralize(unread.count, 'message')})`}
                  />
                ) : null}
                {CHAT_LIMITS.catchUpCounts.map((count) => (
                  <ChoiceRow key={count} value={`${count}`} label={`Last ${count} messages`} />
                ))}
              </RadioGroup>
              {problem ? (
                <AgentConnectionNotice projectId={projectId} taskId={taskId} variant="inline" />
              ) : job ? (
                <p
                  role="status"
                  className="flex items-center gap-2 rounded-md bg-muted/50 px-3 py-2 text-sm"
                  data-testid="catch-up-working"
                >
                  <Spinner />
                  {job.status === 'claimed'
                    ? `Your agent is reading ${pluralize(job.range.count, 'message')}…`
                    : `Waiting for your agent to pick it up (${pluralize(job.range.count, 'message')})…`}
                </p>
              ) : (
                <Button
                  onClick={summarize}
                  disabled={request.isPending || connection.isPending}
                  className="w-full"
                >
                  {request.isPending ? <Spinner /> : <SparklesIcon aria-hidden="true" />}
                  Summarize with my agent
                </Button>
              )}
            </section>
          )}
          {state.data && state.data.summaries.length > 0 ? (
            <section aria-label="Your summaries" className="space-y-3">
              {state.data.summaries.map((summary) => (
                <article
                  key={summary.id}
                  className="rounded-lg border bg-card p-3"
                  data-testid="catch-up-summary"
                >
                  <header className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
                    <h3 className="text-sm font-semibold">What happened</h3>
                    <span className="text-xs text-muted-foreground">
                      {rangeLabel(summary.range)} ·{' '}
                      <RelativeTime value={summary.createdAt} className="text-xs" />
                    </span>
                  </header>
                  <div className="text-sm">
                    <MarkdownView markdown={summary.summary} />
                  </div>
                </article>
              ))}
            </section>
          ) : state.data?.hasAgent && !job ? (
            <p className="text-sm text-muted-foreground">
              No summaries yet. Pick a range and ask your agent.
            </p>
          ) : null}
        </div>
      </SheetContent>
    </Sheet>
  );
}

function ChoiceRow({ value, label }: { value: string; label: string }) {
  const id = `catch-up-${value}`;
  return (
    <div className="flex items-center gap-2">
      <RadioGroupItem value={value} id={id} />
      <Label htmlFor={id} className="font-normal">
        {label}
      </Label>
    </div>
  );
}
