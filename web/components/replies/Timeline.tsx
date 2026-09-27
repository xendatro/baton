import { ErrorState } from '@web/components/common/ErrorState';
import { Spinner } from '@web/components/common/Spinner';
import { Button } from '@web/components/ui/button';
import { useScrollToHash } from '@web/lib/useScrollToHash';
import { ThreadSkeleton, type ThreadProps } from './ReplyThread';
import { FocusedThreadBanner, ReplyBranch, ReplyTreeProvider } from './ReplyTree';
import { useReplyTree } from './threadState';

/**
 * The conversation: top-level replies, each with its answers nested under it (BAT-13); live through
 * query invalidation. `?thread=<replyId>` shows one sub-thread instead. The item's history is not
 * mixed in: it lives in the Activity drawer (`ActivitySheet`).
 */
export function Timeline({ parentType, parentId }: ThreadProps) {
  const tree = useReplyTree(parentType, parentId);
  const replies = tree.query;
  useScrollToHash(tree.ready);
  if (replies.isPending) return <ThreadSkeleton />;
  if (replies.isError) {
    return (
      <div className="space-y-3">
        {tree.focus ? <FocusedThreadBanner ancestors={[]} /> : null}
        <ErrorState
          title={tree.focus ? 'Couldn’t load this thread' : 'Couldn’t load the conversation'}
          error={replies.error}
          onRetry={() => void replies.refetch()}
        />
      </div>
    );
  }
  const forest = tree.forest;
  if (!forest) return <ThreadSkeleton />;

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

  if (forest.roots.length === 0) {
    return (
      <p className="py-2 text-sm text-muted-foreground">
        No replies yet. Start the conversation below.
      </p>
    );
  }
  return (
    <ReplyTreeProvider value={tree.context}>
      <ol className="space-y-2" aria-label="Conversation">
        {forest.roots.map((node) => (
          <li key={node.reply.id}>
            <ReplyBranch node={node} />
          </li>
        ))}
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
