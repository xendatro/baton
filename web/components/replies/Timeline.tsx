import { ErrorState } from '@web/components/common/ErrorState';
import { Spinner } from '@web/components/common/Spinner';
import { Button } from '@web/components/ui/button';
import { useScrollToHash } from '@web/lib/useScrollToHash';
import { ActivityRow } from './ActivityRow';
import { useActivity } from './queries';
import { ThreadSkeleton, type ThreadProps } from './ReplyThread';
import { FocusedThreadBanner, ReplyBranch, ReplyTreeProvider } from './ReplyTree';
import { useReplyTree } from './threadState';
import { mergeTimeline } from './mergeTimeline';

/**
 * Top-level replies interleaved with the item's history, each with its answers nested under it
 * (BAT-13); live through query invalidation. `?thread=<replyId>` shows one sub-thread instead.
 */
export function Timeline({ parentType, parentId }: ThreadProps) {
  const tree = useReplyTree(parentType, parentId);
  const replies = tree.query;
  const activity = useActivity(parentType, parentId);
  useScrollToHash(tree.ready && activity.isSuccess);
  if (replies.isPending || activity.isPending) return <ThreadSkeleton />;
  if (replies.isError || activity.isError) {
    return (
      <div className="space-y-3">
        {tree.focus ? <FocusedThreadBanner ancestors={[]} /> : null}
        <ErrorState
          title={tree.focus ? 'Couldn’t load this thread' : 'Couldn’t load the conversation'}
          error={replies.error ?? activity.error}
          onRetry={() => {
            void replies.refetch();
            void activity.refetch();
          }}
        />
      </div>
    );
  }
  const forest = tree.forest;
  if (!forest) return <ThreadSkeleton />;
  const roots = new Map(forest.roots.map((node) => [node.reply.id, node]));

  if (tree.focus) {
    return (
      <ReplyTreeProvider value={tree.context}>
        <div className="space-y-3">
          <FocusedThreadBanner ancestors={replies.data.ancestors} />
          <ol className="space-y-2" aria-label="Replies">
            {forest.roots.map((node) => (
              <li key={node.reply.id}>
                <ReplyBranch node={node} />
              </li>
            ))}
          </ol>
        </div>
      </ReplyTreeProvider>
    );
  }

  const items = mergeTimeline(
    forest.roots.map((node) => node.reply),
    activity.data,
    parentId,
  );
  if (items.length === 0) {
    return <p className="py-2 text-sm text-muted-foreground">No replies or changes yet.</p>;
  }
  return (
    <ReplyTreeProvider value={tree.context}>
      <ol className="space-y-2" aria-label="Replies and history">
        {items.map((item) => {
          const node = item.kind === 'reply' ? roots.get(item.reply.id) : undefined;
          return (
            <li key={item.kind === 'reply' ? item.reply.id : item.entry.id}>
              {item.kind === 'activity' ? (
                <ActivityRow entry={item.entry} className="px-3" />
              ) : node ? (
                <ReplyBranch node={node} />
              ) : null}
            </li>
          );
        })}
      </ol>
      {tree.moreComments > 0 && tree.canLoadMore ? (
        <Button
          variant="outline"
          size="sm"
          className="mt-3 w-full"
          disabled={replies.isFetching}
          onClick={tree.loadMoreComments}
        >
          {replies.isFetching ? <Spinner /> : null}
          Load {tree.moreComments} more {tree.moreComments === 1 ? 'comment' : 'comments'}
        </Button>
      ) : null}
    </ReplyTreeProvider>
  );
}
