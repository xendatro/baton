import { HandIcon, ListChecksIcon, MessageSquareIcon, ShieldCheckIcon } from 'lucide-react';
import type { TaskPipelineSummary } from '@shared/schemas/pipelines';
import type { TaskCard as TaskCardData } from '@shared/schemas/tasks';
import { BlockedBadge } from '@web/components/common/BlockedBadge';
import { ClaimBadge } from '@web/components/common/ClaimBadge';
import { DueDate } from '@web/components/common/DueDate';
import { LabelChip } from '@web/components/common/LabelChip';
import { PriorityIcon } from '@web/components/common/PriorityIcon';
import { RoleChip } from '@web/components/common/RoleChip';
import { UnreadBadge } from '@web/components/common/UnreadBadge';
import { AvatarStack } from '@web/components/common/UserAvatar';
import { WorkingDot } from '@web/components/common/WorkingDot';
import { cn } from '@web/lib/utils';

/**
 * Body of a board card: key, unread badge (BAT-16), blocked state, title, labels, claim, then a
 * footer of priority (BAT#33: bottom left, nothing for "No priority"), due date, replies and
 * assignees. The card wrapper (link, drag handle, "⋯" button) is the board's.
 */
export function TaskCardBody({
  task,
  showPipeline = false,
  actionsSpace = false,
}: {
  task: TaskCardData;
  /** The "All" view of several pipelines: which one the card is in. */
  showPipeline?: boolean;
  /** Keep the top-right corner free for the card's "⋯" actions button. */
  actionsSpace?: boolean;
}) {
  const done = task.completedAt !== null;
  const { users, roles } = task.assignees;
  // BAT#33: priority sits at the footer's start; "No priority" shows nothing on a card.
  const hasPriority = task.priority !== 0;
  const hasFooter =
    hasPriority ||
    task.dueDate !== null ||
    task.replyCount > 0 ||
    users.length > 0 ||
    roles.length > 0;
  return (
    <div className="flex flex-col gap-2">
      {/* Room on the right for the board's "⋯" actions button. */}
      <div className={cn('flex items-center gap-2', actionsSpace && 'pr-6')}>
        <span className="font-mono text-xs text-muted-foreground tabular-nums">{task.ref}</span>
        {/* BAT-25: with several pipelines on one board, a card says which one it is in. */}
        {showPipeline && task.status.pipeline ? (
          <span
            className="max-w-24 truncate rounded-sm border px-1 text-[11px] leading-4 text-muted-foreground"
            title={`Pipeline: ${task.status.pipeline.name}`}
          >
            {task.status.pipeline.name}
          </span>
        ) : null}
        <WorkingDot working={task.agentWorking} />
        <UnreadBadge count={task.unreadCount} />
        {task.blocked ? <BlockedBadge blockers={task.blockers} /> : null}
      </div>
      <p
        className={cn(
          'line-clamp-3 text-sm leading-snug font-medium break-words',
          done && 'text-muted-foreground',
        )}
      >
        {task.title}
      </p>
      {task.pipeline ? <PipelineBadges pipeline={task.pipeline} /> : null}
      {task.labels.length > 0 ? (
        <div className="flex flex-wrap gap-1">
          {task.labels.map((label) => (
            <LabelChip key={label.id} label={label} />
          ))}
        </div>
      ) : null}
      {task.claim ? (
        <ClaimBadge
          holder={task.claim.user}
          via={task.claim.via}
          claimedAt={task.claim.claimedAt}
          className="self-start"
        />
      ) : null}
      {hasFooter ? (
        <div className="flex min-h-5 items-center gap-3">
          {hasPriority ? <PriorityIcon value={task.priority} /> : null}
          {task.dueDate ? <DueDate value={task.dueDate} done={done} /> : null}
          {task.replyCount > 0 ? (
            <span
              className="inline-flex items-center gap-1 text-xs text-muted-foreground"
              title={`${task.replyCount} ${task.replyCount === 1 ? 'reply' : 'replies'}`}
            >
              <MessageSquareIcon className="size-3.5" aria-hidden="true" />
              {task.replyCount}
              <span className="sr-only">{task.replyCount === 1 ? 'reply' : 'replies'}</span>
            </span>
          ) : null}
          <span className="ml-auto flex min-w-0 items-center gap-1">
            {roles.slice(0, 1).map((role) => (
              <RoleChip key={role.id} role={role} className="max-w-24" />
            ))}
            {roles.length > 1 ? (
              <span
                className="text-xs text-muted-foreground"
                title={roles.map((r) => r.name).join(', ')}
              >
                +{roles.length - 1}
              </span>
            ) : null}
            {users.length > 0 ? (
              <>
                <AvatarStack users={users} size="sm" max={3} />
                <span className="sr-only">
                  Assigned to {users.map((user) => user.name).join(', ')}
                </span>
              </>
            ) : null}
          </span>
        </div>
      ) : null}
    </div>
  );
}

/**
 * What blocks the card in its pipeline stage (design §5): "Approvals 1/2", "Criteria 2/3" (while
 * short) and "Claimable" (waiting in a pool). Text, not just color.
 */
export function PipelineBadges({ pipeline }: { pipeline: TaskPipelineSummary }) {
  const { approvals, criteria, claimable } = pipeline;
  const approvalsShort = approvals && approvals.approved < approvals.required;
  const criteriaShort = criteria && criteria.done < criteria.total;
  if (!approvalsShort && !criteriaShort && !claimable) return null;
  const chip =
    'inline-flex items-center gap-1 rounded-sm border px-1.5 py-0.5 text-[11px] leading-none text-muted-foreground';
  return (
    <div className="flex flex-wrap gap-1">
      {approvalsShort ? (
        <span className={chip} title="Approvals given / needed to move on">
          <ShieldCheckIcon className="size-3" aria-hidden="true" />
          Approvals {approvals.approved}/{approvals.required}
        </span>
      ) : null}
      {criteriaShort ? (
        <span className={chip} title="Exit criteria with evidence / all">
          <ListChecksIcon className="size-3" aria-hidden="true" />
          Criteria {criteria.done}/{criteria.total}
        </span>
      ) : null}
      {claimable ? (
        <span
          className={cn(chip, 'border-indigo-500/40 text-indigo-700 dark:text-indigo-300')}
          title="Waiting in a pool: its members can claim it"
        >
          <HandIcon className="size-3" aria-hidden="true" />
          Claimable
        </span>
      ) : null}
    </div>
  );
}
