import {
  ArrowRightIcon,
  CornerDownRightIcon,
  MessageSquareReplyIcon,
  PlusIcon,
} from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { Link, useLocation } from 'react-router';
import type { ReplyNode } from '@shared/schemas/core';
import { RelativeTime } from '@web/components/common/RelativeTime';
import { Spinner } from '@web/components/common/Spinner';
import { Button } from '@web/components/ui/button';
import { useProjectAccess } from '@web/lib/permissions';
import { ReplyComposer } from './ReplyComposer';
import { ReplyItem } from './ReplyItem';
import { showsAnswers, type ThreadNode } from './threadForest';
import { searchWithThread, ThreadContext, useThread, type ThreadContextValue } from './threadState';

/**
 * Reddit-style threaded replies (BAT-13): each reply can be answered, answers nest under it with a
 * line that collapses the thread, 10 levels show in place ("Continue this thread" beyond), and
 * answers not loaded yet sit behind "N more replies".
 */

export function ReplyTreeProvider({
  value,
  children,
}: {
  value: ThreadContextValue;
  children: ReactNode;
}) {
  return <ThreadContext.Provider value={value}>{children}</ThreadContext.Provider>;
}

// ---------------------------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------------------------

function describe(reply: ReplyNode): string {
  return reply.deleted ? 'deleted reply' : `reply by ${reply.author?.name ?? 'deleted user'}`;
}

function plural(count: number, one: string, many: string) {
  return `${count} ${count === 1 ? one : many}`;
}

/** Answers under a node, loaded or not (as far as the loaded part of the tree knows). */
function answerTotal(node: ThreadNode): number {
  return node.children.reduce((sum, child) => sum + answerTotal(child), node.reply.replyCount);
}

/** Keeps the keyboard focus on a thread's toggle when the viewer collapses or expands it. */
function useFocusWhenToggled(ref: RefObject<HTMLElement | null>, replyId: string) {
  const { toggled } = useThread();
  useEffect(() => {
    if (toggled === replyId) ref.current?.focus({ preventScroll: true });
  }, [ref, toggled, replyId]);
}

/** A deleted reply kept because answers to it are still there. */
function DeletedReply({ reply }: { reply: ReplyNode }) {
  return (
    <article
      id={`reply-${reply.id}`}
      tabIndex={-1}
      aria-label="Deleted reply"
      className="flex scroll-mt-20 items-center gap-2 rounded-lg border border-dashed px-3 py-2 text-sm text-muted-foreground outline-none"
    >
      <span className="italic">[deleted]</span>
      <span aria-hidden="true">·</span>
      <RelativeTime value={reply.createdAt} className="text-xs" />
    </article>
  );
}

/** A collapsed thread: one line naming the reply and how many answers it hides. */
function CollapsedReply({ node }: { node: ThreadNode }) {
  const thread = useThread();
  const { reply } = node;
  const hidden = answerTotal(node);
  const ref = useRef<HTMLButtonElement>(null);
  useFocusWhenToggled(ref, reply.id);
  return (
    <button
      ref={ref}
      type="button"
      aria-expanded={false}
      onClick={() => thread.toggle(reply.id)}
      className="flex w-full flex-wrap items-center gap-x-2 gap-y-0.5 rounded-lg border border-dashed px-3 py-1.5 text-left text-sm text-muted-foreground outline-none hover:bg-muted/50 focus-visible:ring-[3px] focus-visible:ring-ring/50"
    >
      <PlusIcon className="size-4 shrink-0" aria-hidden="true" />
      <span className="sr-only">Expand thread:</span>
      <span className="font-medium text-foreground">
        {reply.deleted ? '[deleted]' : (reply.author?.name ?? 'Deleted user')}
      </span>
      <RelativeTime value={reply.createdAt} className="text-xs" />
      {hidden > 0 ? <span>· {plural(hidden, 'reply', 'replies')} hidden</span> : null}
    </button>
  );
}

/** Actions under a reply: answer it. */
function ReplyActions({
  reply,
  answering,
  onAnswer,
}: {
  reply: ReplyNode;
  answering: boolean;
  onAnswer: () => void;
}) {
  const access = useProjectAccess(reply.teamId, reply.projectId);
  if (!access.has('REPLY')) return null;
  return (
    <div className="-ml-2 flex items-center gap-1">
      <Button
        variant="ghost"
        size="xs"
        className="text-muted-foreground"
        aria-label={`Reply to ${reply.author?.name ?? 'deleted user'}`}
        aria-expanded={answering}
        onClick={onAnswer}
      >
        <MessageSquareReplyIcon aria-hidden="true" />
        Reply
      </Button>
    </div>
  );
}

/** One reply with its answers, recursively. */
export function ReplyBranch({ node }: { node: ThreadNode }) {
  const thread = useThread();
  const { reply } = node;
  const [answering, setAnswering] = useState(() => thread.hasDraft(reply.id));
  if (thread.collapsed.has(reply.id)) return <CollapsedReply node={node} />;
  return <OpenBranch node={node} answering={answering} setAnswering={setAnswering} />;
}

function OpenBranch({
  node,
  answering,
  setAnswering,
}: {
  node: ThreadNode;
  answering: boolean;
  setAnswering: (update: (open: boolean) => boolean) => void;
}) {
  const thread = useThread();
  const { reply } = node;
  const line = useRef<HTMLButtonElement>(null);
  useFocusWhenToggled(line, reply.id);

  const nested = showsAnswers(node);
  const children = nested ? node.children : [];
  const branch = answering || children.length > 0 || (nested && node.hidden > 0);
  const name = describe(reply);
  return (
    <div className="space-y-2" data-reply-branch={reply.id}>
      {reply.deleted ? (
        <DeletedReply reply={reply} />
      ) : (
        <ReplyItem
          reply={reply}
          footer={
            <ReplyActions
              reply={reply}
              answering={answering}
              onAnswer={() => setAnswering((open) => !open)}
            />
          }
        />
      )}
      {branch ? (
        <div className="flex">
          <button
            ref={line}
            type="button"
            aria-expanded={true}
            aria-label={`Collapse thread: ${name}`}
            title="Collapse thread"
            onClick={() => thread.toggle(reply.id)}
            className="group/line relative w-5 shrink-0 cursor-pointer rounded-sm outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 sm:w-6"
          >
            <span
              aria-hidden="true"
              className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-border transition-colors group-hover/line:w-0.5 group-hover/line:bg-primary"
            />
          </button>
          <div className="min-w-0 flex-1 space-y-2">
            {answering ? (
              <ReplyComposer
                parentType={thread.parentType}
                parentId={thread.parentId}
                teamId={reply.teamId}
                projectId={reply.projectId}
                parentReplyId={reply.id}
                label={`Reply to ${name}`}
                placeholder={`Reply to ${reply.author?.name ?? 'this reply'}…`}
                autoFocus
                onCancel={() => setAnswering(() => false)}
                onSent={() => setAnswering(() => false)}
              />
            ) : null}
            {children.length > 0 ? (
              <ol className="space-y-2" aria-label={`Answers to ${name}`}>
                {children.map((child) => (
                  <li key={child.reply.id}>
                    <ReplyBranch node={child} />
                  </li>
                ))}
              </ol>
            ) : null}
            {nested && node.hidden > 0 ? (
              <Button
                variant="link"
                size="xs"
                className="px-0"
                disabled={thread.expanding !== null}
                onClick={() => thread.expand(reply.id)}
              >
                {thread.expanding === reply.id ? (
                  <Spinner />
                ) : (
                  <CornerDownRightIcon aria-hidden="true" />
                )}
                {plural(node.hidden, 'more reply', 'more replies')}
              </Button>
            ) : null}
          </div>
        </div>
      ) : null}
      {!nested && reply.replyCount > 0 ? (
        <Link
          to={thread.threadHref(reply.id)}
          className="ml-1 inline-flex items-center gap-1 text-sm font-medium text-primary underline-offset-4 hover:underline"
        >
          Continue this thread
          <ArrowRightIcon className="size-3.5" aria-hidden="true" />
        </Link>
      ) : null}
    </div>
  );
}

/** Banner of a focused sub-thread: back to every comment, or up to the parent comment. */
export function FocusedThreadBanner({ ancestors }: { ancestors: readonly string[] }) {
  const { pathname, search } = useLocation();
  const parent = ancestors.at(-1);
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border bg-muted/40 px-3 py-2 text-sm">
      <span className="text-muted-foreground">You’re viewing a single comment thread.</span>
      <Link
        to={{ pathname, search: searchWithThread(search, null) }}
        className="font-medium text-primary underline-offset-4 hover:underline"
      >
        View all comments
      </Link>
      {parent ? (
        <Link
          to={{ pathname, search: searchWithThread(search, parent) }}
          className="font-medium text-primary underline-offset-4 hover:underline"
        >
          Show parent comment
        </Link>
      ) : null}
    </div>
  );
}
