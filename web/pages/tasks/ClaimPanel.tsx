import { BotIcon, HandIcon } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import type { Task } from '@shared/schemas/tasks';
import { ConfirmDialog } from '@web/components/common/ConfirmDialog';
import { Spinner } from '@web/components/common/Spinner';
import { UserName } from '@web/components/common/UserName';
import { useNow } from '@web/components/common/useNow';
import { Button } from '@web/components/ui/button';
import { errorMessage } from '@web/lib/api';
import { formatDateTime } from '@web/lib/format';
import { cn } from '@web/lib/utils';
import { claimedAgo } from './helpers';
import { useClaimAction, type ClaimAction } from './queries';

/**
 * Who is working on the task (SPEC §1.8): the claim holder and their key ("ethan via Claude on
 * laptop"), when they claimed it and how long the lease has left, with Claim / Release / Take
 * over for web users. A web claim is held by the user without a key ("ethan (web)").
 */

export interface ClaimPanelProps {
  task: Task;
  viewerId: string | null;
  /** The viewer may claim, release and take over (author or `UPDATE_TASKS`). */
  canClaim: boolean;
  /** Taking over someone else's claim needs `UPDATE_TASKS`. */
  canTakeOver: boolean;
  /** The task's stage is claimable (its `claimable` rule; default true). */
  claimable?: boolean;
}

export function ClaimPanel({
  task,
  viewerId,
  canClaim,
  canTakeOver,
  claimable = true,
}: ClaimPanelProps) {
  const now = useNow();
  const action = useClaimAction(task);
  const [confirmTakeover, setConfirmTakeover] = useState(false);
  const { claim } = task;

  const mineOnWeb = claim !== null && claim.user.id === viewerId && claim.via === null;
  // Through a key the holder is the viewer's agent member (agents A); older claims name the viewer.
  const mineViaKey =
    claim !== null &&
    claim.via !== null &&
    (claim.user.id === viewerId || claim.user.agentOwner?.id === viewerId);

  const run = (next: ClaimAction, success: string) =>
    action.mutateAsync(next).then(
      () => {
        toast.success(success);
      },
      (error: unknown) => {
        toast.error(errorMessage(error));
        throw error;
      },
    );

  return (
    <section
      aria-labelledby="claim-heading"
      className={cn(
        'rounded-lg border p-3',
        claim && 'border-emerald-500/40 bg-emerald-500/5 dark:bg-emerald-500/10',
      )}
    >
      <h2
        id="claim-heading"
        className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground"
      >
        <HandIcon className="size-3.5" aria-hidden="true" />
        Claim
      </h2>
      {claim ? (
        <div className="mt-2 grid gap-1.5 text-sm">
          <div className="flex min-w-0 flex-wrap items-center gap-x-1.5">
            <UserName user={claim.user} avatar="sm" />
            {claim.via ? (
              <span className="inline-flex min-w-0 items-center gap-1 text-muted-foreground">
                via <BotIcon className="size-3.5 shrink-0" aria-label="agent" />
                <span className="truncate">{claim.via.keyName}</span>
              </span>
            ) : (
              <span className="text-muted-foreground">(web)</span>
            )}
          </div>
          <p className="flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
            <span title={formatDateTime(claim.claimedAt)}>{claimedAgo(claim.claimedAt, now)}</span>
          </p>
        </div>
      ) : (
        <p className="mt-2 text-sm text-muted-foreground">
          {claimable
            ? 'Nobody is working on this.'
            : `Tasks in ${task.status.name} aren’t claimed.`}
        </p>
      )}
      {canClaim ? (
        <div className="mt-3 flex flex-wrap gap-2">
          {!claim && claimable ? (
            <Button
              size="sm"
              variant="outline"
              disabled={action.isPending}
              onClick={() => void run({ kind: 'claim' }, 'You claimed this task').catch(() => {})}
            >
              {action.isPending ? <Spinner /> : <HandIcon aria-hidden="true" />}
              Claim
            </Button>
          ) : null}
          {mineOnWeb ? (
            <>
              <Button
                size="sm"
                variant="outline"
                disabled={action.isPending}
                onClick={() => void run({ kind: 'release' }, 'Claim released').catch(() => {})}
              >
                Release
              </Button>
            </>
          ) : null}
          {mineViaKey ? (
            <Button
              size="sm"
              variant="outline"
              disabled={action.isPending}
              onClick={() =>
                void run({ kind: 'release' }, 'Your agent’s claim was released').catch(() => {})
              }
            >
              Release
            </Button>
          ) : null}
          {claim && claim.user.id !== viewerId && canTakeOver ? (
            <Button
              size="sm"
              variant="outline"
              disabled={action.isPending}
              onClick={() => setConfirmTakeover(true)}
            >
              Take over
            </Button>
          ) : null}
        </div>
      ) : null}
      <ConfirmDialog
        open={confirmTakeover}
        onOpenChange={setConfirmTakeover}
        title="Take over this claim?"
        description={
          claim
            ? `${claim.user.name}${claim.via ? ` via ${claim.via.keyName}` : ''} is working on ${task.ref}. Taking over makes you the holder; it is recorded in the history.`
            : undefined
        }
        confirmLabel="Take over"
        onConfirm={() => run({ kind: 'claim', input: { force: true } }, 'You took over the claim')}
      />
    </section>
  );
}
