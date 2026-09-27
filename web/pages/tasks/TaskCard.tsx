import { MessageSquareIcon } from 'lucide-react';
import type { TaskCard as TaskCardData } from '@shared/schemas/tasks';
import { BlockedBadge } from '@web/components/common/BlockedBadge';
import { ClaimBadge } from '@web/components/common/ClaimBadge';
import { DueDate } from '@web/components/common/DueDate';
import { LabelChip } from '@web/components/common/LabelChip';
import { PriorityIcon } from '@web/components/common/PriorityIcon';
import { RoleChip } from '@web/components/common/RoleChip';
import { UnreadBadge } from '@web/components/common/UnreadBadge';
import { AvatarStack } from '@web/components/common/UserAvatar';
import { cn } from '@web/lib/utils';

/**
 * Body of a board card: key, unread badge (BAT-16), priority and blocked state, title, labels,
 * claim, due date, replies and assignees. The card wrapper (link, drag handle) is the board's.
 */
export function TaskCardBody({ task }: { task: TaskCardData }) {
  const done = task.status.category === 'done';
  const { users, roles } = task.assignees;
  const hasFooter =
    task.dueDate !== null || task.replyCount > 0 || users.length > 0 || roles.length > 0;
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <span className="font-mono text-xs text-muted-foreground tabular-nums">{task.ref}</span>
        <UnreadBadge count={task.unreadCount} />
        {task.blocked ? <BlockedBadge blockers={task.blockers} /> : null}
        <PriorityIcon value={task.priority} className="ml-auto" />
      </div>
      <p
        className={cn(
          'line-clamp-3 text-sm leading-snug font-medium break-words',
          done && 'text-muted-foreground',
        )}
      >
        {task.title}
      </p>
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
          expiresAt={task.claim.expiresAt}
          className="self-start"
        />
      ) : null}
      {hasFooter ? (
        <div className="flex min-h-5 items-center gap-3">
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
