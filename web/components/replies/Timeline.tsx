import { ErrorState } from '@web/components/common/ErrorState';
import { useScrollToHash } from '@web/lib/useScrollToHash';
import { ActivityRow } from './ActivityRow';
import { useActivity, useReplies } from './queries';
import { ReplyItem } from './ReplyItem';
import { ThreadSkeleton, type ThreadProps } from './ReplyThread';
import { mergeTimeline } from './mergeTimeline';

/** Replies interleaved with the item's history (live through query invalidation). */
export function Timeline({ parentType, parentId }: ThreadProps) {
  const replies = useReplies(parentType, parentId);
  const activity = useActivity(parentType, parentId);
  useScrollToHash(replies.isSuccess && activity.isSuccess);
  if (replies.isPending || activity.isPending) return <ThreadSkeleton />;
  if (replies.isError || activity.isError) {
    return (
      <ErrorState
        title="Couldn’t load the conversation"
        error={replies.error ?? activity.error}
        onRetry={() => {
          void replies.refetch();
          void activity.refetch();
        }}
      />
    );
  }
  const items = mergeTimeline(replies.data, activity.data, parentId);
  if (items.length === 0) {
    return <p className="py-2 text-sm text-muted-foreground">No replies or changes yet.</p>;
  }
  return (
    <ol className="space-y-2" aria-label="Replies and history">
      {items.map((item) => (
        <li key={item.kind === 'reply' ? item.reply.id : item.entry.id}>
          {item.kind === 'reply' ? (
            <ReplyItem reply={item.reply} />
          ) : (
            <ActivityRow entry={item.entry} className="px-3" />
          )}
        </li>
      ))}
    </ol>
  );
}
