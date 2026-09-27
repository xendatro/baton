import { MessageSquareIcon } from 'lucide-react';
import type { ReplyParentType } from '@shared/constants';
import { EmptyState } from '@web/components/common/EmptyState';
import { ErrorState } from '@web/components/common/ErrorState';
import { Skeleton } from '@web/components/ui/skeleton';
import { useScrollToHash } from '@web/lib/useScrollToHash';
import { FocusedThreadBanner, ReplyBranch, ReplyTreeProvider } from './ReplyTree';
import { useReplyTree } from './threadState';

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

/** Replies only, oldest first, answers nested under what they answer (BAT-13). */
export function ReplyThread({ parentType, parentId }: ThreadProps) {
  const tree = useReplyTree(parentType, parentId);
  const replies = tree.query;
  useScrollToHash(tree.ready);
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
  if (!tree.forest || tree.forest.roots.length === 0) {
    return (
      <EmptyState
        icon={MessageSquareIcon}
        title="No replies yet"
        description="Start the conversation below."
      />
    );
  }
  return (
    <ReplyTreeProvider value={tree.context}>
      <div className="space-y-3">
        {tree.focus ? <FocusedThreadBanner ancestors={replies.data.ancestors} /> : null}
        <ol className="space-y-3" aria-label="Replies">
          {tree.forest.roots.map((node) => (
            <li key={node.reply.id}>
              <ReplyBranch node={node} />
            </li>
          ))}
        </ol>
      </div>
    </ReplyTreeProvider>
  );
}
