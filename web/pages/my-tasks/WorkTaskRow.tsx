import { BotIcon, HandIcon } from 'lucide-react';
import { Link } from 'react-router';
import type { MyTask } from '@shared/schemas/work';
import { BlockedBadge } from '@web/components/common/BlockedBadge';
import { ClaimBadge } from '@web/components/common/ClaimBadge';
import { DueDate } from '@web/components/common/DueDate';
import { LabelChip } from '@web/components/common/LabelChip';
import { PriorityIcon } from '@web/components/common/PriorityIcon';
import { RoleChip } from '@web/components/common/RoleChip';
import { StatusBadge } from '@web/components/common/StatusBadge';
import { TaskKey } from '@web/components/common/TaskKey';
import { cn } from '@web/lib/utils';
import { assignmentHint } from './filters';

/** Labels shown before "+n". */
const LABELS_SHOWN = 2;

export interface WorkTaskRowProps {
  task: MyTask;
  /** Show the team and project (lists that mix projects without grouping them). */
  showContext?: boolean;
  /** Show the claim as a full badge (holder, key, age) under the title instead of an icon. */
  claimBadge?: boolean;
  className?: string;
}

/**
 * One task in the work lists (My tasks, dashboard): priority, key, status, title, why it is mine,
 * labels, claim and due date. The whole row links to the task page.
 */
export function WorkTaskRow({
  task,
  showContext = false,
  claimBadge = false,
  className,
}: WorkTaskRowProps) {
  const hint = assignmentHint(task);
  const extraLabels = task.labels.length - LABELS_SHOWN;
  const done = task.status.category === 'done';
  return (
    <li className={className}>
      <Link
        to={task.url}
        className="group flex min-w-0 items-start gap-3 px-3 py-2.5 transition-colors outline-none hover:bg-accent/50 focus-visible:bg-accent/50 focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-inset sm:items-center sm:px-4"
      >
        <PriorityIcon value={task.priority} className="mt-0.5 sm:mt-0" />
        <TaskKey
          projectKey={task.project.key}
          number={task.number}
          className="mt-0.5 hidden w-16 sm:mt-0 sm:inline"
        />
        {/* Phones name the status on the second line; wider screens next to the icon, since the
            open statuses share one icon and would differ by color alone (SPEC §6). */}
        <StatusBadge status={task.status} iconOnly className="mt-0.5 sm:hidden" />
        <StatusBadge
          status={task.status}
          className="hidden w-28 shrink-0 text-xs text-muted-foreground sm:inline-flex"
        />
        <span className="min-w-0 flex-1">
          <span className="flex min-w-0 items-center gap-2">
            <span className="truncate text-sm font-medium text-foreground group-hover:underline">
              {task.title}
            </span>
            {task.blocked ? <BlockedBadge className="hidden sm:inline-flex" /> : null}
          </span>
          {/* Second line on phones; inline context on wider screens. */}
          <span className="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground sm:hidden">
            <span className="font-mono">{task.ref}</span>
            <span>{task.status.name}</span>
            {task.dueDate ? <DueDate value={task.dueDate} done={done} /> : null}
            {task.blocked ? <BlockedBadge /> : null}
            {hint ? <span className="truncate">{hint}</span> : null}
            {showContext ? <span className="truncate">{task.project.name}</span> : null}
            {claimBadge && task.claim ? (
              <span className="inline-flex items-center gap-1 text-emerald-700 dark:text-emerald-400">
                {task.claim.via ? (
                  <BotIcon className="size-3" aria-hidden="true" />
                ) : (
                  <HandIcon className="size-3" aria-hidden="true" />
                )}
                {task.claim.via ? task.claim.via.keyName : 'Web'}
              </span>
            ) : null}
          </span>
          {showContext || (claimBadge && task.claim) ? (
            <span className="mt-0.5 hidden min-w-0 items-center gap-2 text-xs text-muted-foreground sm:flex">
              {showContext ? (
                <span className="truncate">
                  {task.team.name} · {task.project.name}
                </span>
              ) : null}
              {/* Claim lists show the holder under the title, where there is room for it. */}
              {claimBadge && task.claim ? (
                <ClaimBadge
                  holder={task.claim.user}
                  via={task.claim.via}
                  claimedAt={task.claim.claimedAt}
                  className="h-5 max-w-72 shrink-0"
                />
              ) : null}
            </span>
          ) : null}
        </span>
        <span
          className={cn(
            'hidden shrink-0 items-center gap-1.5',
            // Lists with context (the dashboard) are narrower: the title comes first.
            claimBadge ? 'hidden' : showContext ? '2xl:flex' : 'md:flex',
          )}
        >
          {task.labels.slice(0, LABELS_SHOWN).map((label) => (
            <LabelChip key={label.id} label={label} />
          ))}
          {extraLabels > 0 ? (
            <span
              className="text-xs text-muted-foreground"
              title={task.labels
                .slice(LABELS_SHOWN)
                .map((label) => label.name)
                .join(', ')}
            >
              +{extraLabels}
            </span>
          ) : null}
        </span>
        {hint ? (
          <span className="hidden shrink-0 items-center gap-1 text-xs text-muted-foreground sm:flex">
            <span>via</span>
            {task.assignment.roles.slice(0, 2).map((role) => (
              <RoleChip key={role.id} role={role} />
            ))}
            <span className="sr-only">{hint}</span>
          </span>
        ) : null}
        {task.claim && !claimBadge ? (
          <span
            className="hidden shrink-0 text-emerald-600 sm:inline dark:text-emerald-400"
            title={`Claimed by ${task.claim.user.name}${task.claim.via ? ` via ${task.claim.via.keyName}` : ' (web)'}`}
          >
            {task.claim.via ? (
              <BotIcon className="size-4" aria-hidden="true" />
            ) : (
              <HandIcon className="size-4" aria-hidden="true" />
            )}
            <span className="sr-only">
              Claimed by {task.claim.user.name}
              {task.claim.via ? ` via ${task.claim.via.keyName}` : ' (web)'}
            </span>
          </span>
        ) : null}
        {/* A fixed-width column, so due dates line up from row to row. */}
        <span className="hidden w-24 shrink-0 justify-end sm:flex">
          {task.dueDate ? <DueDate value={task.dueDate} done={done} /> : null}
        </span>
      </Link>
    </li>
  );
}
