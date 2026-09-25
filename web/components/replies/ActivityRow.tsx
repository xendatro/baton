import { HistoryIcon } from 'lucide-react';
import { Fragment } from 'react';
import type { ActivityEntry } from '@shared/schemas/core';
import { RelativeTime } from '@web/components/common/RelativeTime';
import { UserName } from '@web/components/common/UserName';
import { cn } from '@web/lib/utils';
import { describeActivity } from './describeActivity';

export interface ActivityRowProps {
  entry: ActivityEntry;
  className?: string;
}

/** Compact history row: "ethan via Claude on laptop changed status from Open to Done · 4m ago". */
export function ActivityRow({ entry, className }: ActivityRowProps) {
  const parts = describeActivity(entry);
  return (
    <div className={cn('flex items-start gap-2.5 py-1 text-sm text-muted-foreground', className)}>
      <span className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full bg-muted">
        <HistoryIcon className="size-3" aria-hidden="true" />
      </span>
      <p className="min-w-0 flex-1 leading-6">
        <UserName
          user={entry.actor.user}
          via={entry.actor.via}
          source={entry.actor.source}
          className="mr-1 align-bottom"
        />
        {parts.map((part, index) => (
          <Fragment key={index}>
            {part.text === ',' ? '' : ' '}
            {part.emphasis ? (
              <span className="font-medium text-foreground">{part.text}</span>
            ) : (
              part.text
            )}
          </Fragment>
        ))}
        <span aria-hidden="true"> · </span>
        <RelativeTime value={entry.createdAt} />
      </p>
    </div>
  );
}
