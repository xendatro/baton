import { MessageSquareIcon } from 'lucide-react';
import type { ReplyParentType } from '@shared/constants';
import { EmptyState } from '@web/components/common/EmptyState';
import { ErrorState } from '@web/components/common/ErrorState';
import { Skeleton } from '@web/components/ui/skeleton';
import { useReplies } from './queries';
import { ReplyItem } from './ReplyItem';

export function ThreadSkeleton() {
  return (
    <div className="space-y-3" aria-busy="true" aria-label="Loading replies">
      {[0, 1].map((index) => (
        <div key={index} className="flex gap-3 rounded-lg border p-3">
          <Skeleton className="size-8 rounded-full" />
          <div className="flex-1 space-y-2">
            <Skeleton className="h-4 w-40" />
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-2/3" />
          </div>
        </div>
      ))}
    </div>
  );
}

export interface ThreadProps {
  parentType: ReplyParentType;
  parentId: string;
}

/** Replies only, oldest first. */
export function ReplyThread({ parentType, parentId }: ThreadProps) {
  const replies = useReplies(parentType, parentId);
  if (replies.isPending) return <ThreadSkeleton />;
  if (replies.isError) {
    return (
      <ErrorState
        title="Couldn’t load replies"
        error={replies.error}
        onRetry={() => void replies.refetch()}
      />
    );
  }
  if (replies.data.length === 0) {
    return (
      <EmptyState
        icon={MessageSquareIcon}
        title="No replies yet"
        description="Start the conversation below."
      />
    );
  }
  return (
    <div className="space-y-3">
      {replies.data.map((reply) => (
        <ReplyItem key={reply.id} reply={reply} />
      ))}
    </div>
  );
}
