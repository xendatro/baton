import { MessageSquareIcon } from 'lucide-react';
import type { Ref } from 'react';
import { Link } from 'react-router';
import type { IssueSummary } from '@shared/schemas/issues';
import { LabelChip } from '@web/components/common/LabelChip';
import { RelativeTime } from '@web/components/common/RelativeTime';
import { UnreadBadge } from '@web/components/common/UnreadBadge';
import { UserName } from '@web/components/common/UserName';
import { Skeleton } from '@web/components/ui/skeleton';
import { pluralize } from '@web/lib/format';
import { cn } from '@web/lib/utils';
import { IssueStateIcon } from './IssueState';

/**
 * One row of the issue list, GitHub style: state, title (the link, stretched over the row),
 * the viewer's unread badge (BAT-16), labels, then `#n`, author (+ via key) and times; the reply
 * count on the right.
 */
export function IssueRow({
  issue,
  selected,
  onFocus,
  linkRef,
}: {
  issue: IssueSummary;
  selected: boolean;
  onFocus: () => void;
  linkRef?: Ref<HTMLAnchorElement>;
}) {
  return (
    <li
      className={cn(
        'relative flex gap-3 px-3 py-3 transition-colors hover:bg-accent/50 sm:px-4',
        selected && 'bg-accent/50',
      )}
    >
      <IssueStateIcon resolved={issue.resolved} className="mt-0.5" />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <Link
            ref={linkRef}
            to={issue.path}
            onFocus={onFocus}
            className="min-w-0 font-medium break-words outline-none after:absolute after:inset-0 after:rounded-sm hover:text-primary focus-visible:after:ring-2 focus-visible:after:ring-ring focus-visible:after:ring-inset"
          >
            {issue.title}
          </Link>
          <UnreadBadge count={issue.unreadCount} className="relative" />
          {issue.labels.map((label) => (
            <LabelChip key={label.id} label={label} className="relative" />
          ))}
        </div>
        <p className="mt-1 flex flex-wrap items-center gap-x-1 gap-y-0.5 text-xs text-muted-foreground">
          <span className="font-mono">#{issue.number}</span>
          <span aria-hidden="true">·</span>
          <span>{issue.resolved ? 'resolved' : 'opened'}</span>
          <RelativeTime
            value={issue.resolved && issue.resolvedAt ? issue.resolvedAt : issue.createdAt}
          />
          <span>{issue.resolved ? '· opened by' : 'by'}</span>
          <UserName user={issue.author} via={issue.via} hovercard={false} className="text-xs" />
          <span className="sm:hidden" aria-hidden="true">
            ·
          </span>
          <span className="sm:hidden">{pluralize(issue.replyCount, 'reply', 'replies')}</span>
        </p>
      </div>
      <div className="hidden shrink-0 flex-col items-end gap-1 text-xs text-muted-foreground sm:flex">
        <span
          className={cn(
            'inline-flex items-center gap-1 tabular-nums',
            issue.replyCount === 0 && 'opacity-60',
          )}
          aria-label={pluralize(issue.replyCount, 'reply', 'replies')}
        >
          <MessageSquareIcon className="size-3.5" aria-hidden="true" />
          {issue.replyCount}
        </span>
        <span className="inline-flex items-center gap-1">
          <span className="sr-only">Last activity</span>
          <RelativeTime value={issue.lastActivityAt} />
        </span>
      </div>
    </li>
  );
}

export function IssueRowSkeleton() {
  return (
    <li className="flex gap-3 px-3 py-3 sm:px-4">
      <Skeleton className="mt-0.5 size-4 rounded-full" />
      <div className="grid flex-1 gap-2">
        <Skeleton className="h-4 w-2/3 max-w-md" />
        <Skeleton className="h-3 w-1/2 max-w-xs" />
      </div>
      <Skeleton className="hidden h-8 w-12 sm:block" />
    </li>
  );
}
