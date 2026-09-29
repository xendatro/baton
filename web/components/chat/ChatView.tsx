import {
  ArrowDownIcon,
  BotIcon,
  ListChecksIcon,
  ListPlusIcon,
  MessageCircleIcon,
  SparklesIcon,
  XIcon,
} from 'lucide-react';
import {
  Fragment,
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type UIEvent,
} from 'react';
import { CHAT_LIMITS, type ReplyParentType } from '@shared/constants';
import type { Reply } from '@shared/schemas/core';
import { ItemAgentRequests } from '@web/components/agentRequests/ItemAgentRequests';
import { ErrorState } from '@web/components/common/ErrorState';
import { Spinner } from '@web/components/common/Spinner';
import { threadAgents, type ThreadWrite } from '@web/components/replies/threadAgents';
import { Button } from '@web/components/ui/button';
import { Skeleton } from '@web/components/ui/skeleton';
import { useSession } from '@web/lib/auth';
import { pluralize } from '@web/lib/format';
import { queryKeys } from '@web/lib/queryKeys';
import { useScrollToHash } from '@web/lib/useScrollToHash';
import { cn } from '@web/lib/utils';
import { useMembers } from '@web/pages/teams/api';
import { CatchUpPanel } from './CatchUpPanel';
import { ChatComposer } from './ChatComposer';
import { ChatMessage, type QuotedMessage } from './ChatMessage';
import { useMakeTask } from './conversationItem';
import { chatMessages, continuesGroup, typingText } from './chatLayout';
import { useChatMessages, useTypingPing } from './queries';
import { useTypingPeople } from './useTypingPeople';

export interface ChatViewProps {
  parentType: ReplyParentType;
  parentId: string;
  teamId: string;
  projectId: string;
  /** The task or issue: its ref and path, and its author for `@` suggestions. */
  item: ThreadWrite & { ref: string; path: string };
  /**
   * BAT-43: fill the parent's height (a flex column of fixed height): the stream takes what the
   * header and composer leave and scrolls on its own, with the composer pinned at the bottom.
   */
  fill?: boolean;
}

/** Within this many pixels of the end, the stream follows new messages. */
const STICK_PX = 80;

/**
 * The chat of an issue or task: a flat, chronological stream of compact messages (grouped by
 * author), a "new messages" divider at the first unread one, "Jump to latest", who is typing or
 * which agent is working, the Catch up panel, and the composer pinned at the bottom.
 */
export function ChatView({
  parentType,
  parentId,
  teamId,
  projectId,
  item,
  fill = false,
}: ChatViewProps) {
  const query = useChatMessages(parentType, parentId);
  const viewerId = useSession().data?.user.id ?? null;
  const members = useMembers(teamId).data?.items;
  const typingIds = useTypingPeople(parentType, parentId, viewerId);
  const typing = useTypingPing(parentType, parentId);
  const scroller = useRef<HTMLDivElement>(null);
  const [replyTo, setReplyTo] = useState<Reply | null>(null);
  const [catchUpOpen, setCatchUpOpen] = useState(false);
  // "Select messages" (Make task from N messages); null when not selecting.
  const [selected, setSelected] = useState<ReadonlySet<string> | null>(null);
  const makeTask = useMakeTask();
  const toggleSelected = useCallback((replyId: string) => {
    setSelected((current) => {
      const next = new Set(current ?? []);
      if (next.has(replyId)) next.delete(replyId);
      else next.add(replyId);
      return next;
    });
  }, []);
  const makeTaskFromOne = useCallback(
    (message: Reply) => {
      makeTask?.([message]);
    },
    [makeTask],
  );
  const [stripHidden, setStripHidden] = useState(false);
  const [atBottom, setAtBottom] = useState(true);
  const [unseen, setUnseen] = useState(0);
  const stick = useRef(true);
  const pages = query.data?.pages;
  const messages = useMemo(() => chatMessages(pages), [pages]);
  const newest = pages?.[0];

  // The unread state as the chat opened (it is marked read right after).
  const [unread, setUnread] = useState<{ count: number; firstReplyId: string | null } | null>(null);
  if (!unread && newest) setUnread(newest.unread);
  const dividerId = unread && unread.count > 0 ? unread.firstReplyId : null;

  const byId = useMemo(() => new Map(messages.map((message) => [message.id, message])), [messages]);
  const agents = useMemo(() => threadAgents([item, ...messages]), [item, messages]);
  const queryKey = queryKeys.replies.chat(parentType, parentId);

  const scrollToEnd = useCallback(() => {
    const element = scroller.current;
    if (!element) return;
    element.scrollTop = element.scrollHeight;
    stick.current = true;
    setAtBottom(true);
    setUnseen(0);
  }, []);

  // First load: open at the first unread message, else at the end (a #reply link wins).
  const opened = useRef(false);
  useLayoutEffect(() => {
    const element = scroller.current;
    if (opened.current || !element || !unread || messages.length === 0) return;
    opened.current = true;
    if (window.location.hash.startsWith('#reply-')) return;
    const divider = dividerId ? element.querySelector<HTMLElement>('[data-chat-divider]') : null;
    if (divider) {
      element.scrollTop = Math.max(0, divider.offsetTop - 48);
      stick.current = false;
      setAtBottom(element.scrollHeight - element.scrollTop - element.clientHeight < STICK_PX);
    } else {
      scrollToEnd();
    }
  }, [unread, messages.length, dividerId, scrollToEnd]);
  useScrollToHash(unread !== null && messages.length > 0);

  // New messages: follow them at the end of the stream, else count them for "Jump to latest".
  const lastId = messages.at(-1)?.id ?? null;
  const previousLast = useRef<string | null>(null);
  useLayoutEffect(() => {
    const previous = previousLast.current;
    previousLast.current = lastId;
    if (!previous || !lastId || previous === lastId || !opened.current) return;
    const last = messages.at(-1);
    if (stick.current || last?.author?.id === viewerId) scrollToEnd();
    else {
      const index = messages.findIndex((message) => message.id === previous);
      setUnseen((count) => count + Math.max(1, messages.length - 1 - index));
    }
  }, [lastId, messages, viewerId, scrollToEnd]);

  // Older pages load above: keep the messages in view where they were.
  const anchor = useRef<{ height: number; top: number } | null>(null);
  const pageCount = pages?.length ?? 0;
  useLayoutEffect(() => {
    const element = scroller.current;
    const saved = anchor.current;
    if (!element || !saved) return;
    anchor.current = null;
    element.scrollTop = element.scrollHeight - saved.height + saved.top;
  }, [pageCount]);

  const loadOlder = useCallback(() => {
    const element = scroller.current;
    if (!element || !query.hasNextPage || query.isFetchingNextPage) return;
    anchor.current = { height: element.scrollHeight, top: element.scrollTop };
    void query.fetchNextPage();
  }, [query]);

  const onScroll = (event: UIEvent<HTMLDivElement>) => {
    const element = event.currentTarget;
    const bottom = element.scrollHeight - element.scrollTop - element.clientHeight < STICK_PX;
    stick.current = bottom;
    setAtBottom(bottom);
    if (bottom) setUnseen(0);
    if (element.scrollTop < 40 && opened.current) loadOlder();
  };

  const jumpTo = useCallback((replyId: string) => {
    const target = document.getElementById(`reply-${replyId}`);
    if (!target) return;
    const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
    target.scrollIntoView?.({ block: 'center', behavior: reduceMotion ? 'auto' : 'smooth' });
    target.focus({ preventScroll: true });
    target.animate?.(
      [{ backgroundColor: 'color-mix(in oklab, var(--primary) 15%, transparent)' }, {}],
      { duration: 1800, easing: 'ease-out' },
    );
  }, []);

  const names = useMemo(
    () => new Map((members ?? []).map((member) => [member.user.id, member.user.name])),
    [members],
  );
  const typingLine = typingText(typingIds.map((id) => names.get(id) ?? 'Someone'));
  const working = (newest?.workingAgents ?? []).filter((agent) => !typingIds.includes(agent.id));
  const showStrip = !stripHidden && unread !== null && unread.count >= CHAT_LIMITS.catchUpThreshold;

  let body;
  if (query.isPending) {
    body = <ChatSkeleton />;
  } else if (query.isError) {
    body = (
      <div className="p-4">
        <ErrorState
          title="Couldn’t load the chat"
          error={query.error}
          onRetry={() => void query.refetch()}
        />
      </div>
    );
  } else if (messages.length === 0) {
    body = (
      <div className="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center">
        <MessageCircleIcon className="size-8 text-muted-foreground" aria-hidden="true" />
        <p className="font-medium">No messages yet</p>
        <p className="text-sm text-muted-foreground">
          Start the conversation below. Mention an agent with @ to bring it in.
        </p>
      </div>
    );
  } else {
    body = (
      <ol className="pb-2" aria-label="Messages">
        {query.hasNextPage ? (
          <li className="flex justify-center py-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={loadOlder}
              disabled={query.isFetchingNextPage}
            >
              {query.isFetchingNextPage ? <Spinner /> : null}
              Load older messages
            </Button>
          </li>
        ) : (
          <li className="px-3 pt-3 pb-1 text-xs text-muted-foreground">
            This is the start of the chat of {item.ref}.
          </li>
        )}
        {messages.map((message, index) => {
          const divider = message.id === dividerId;
          const answered = message.parentReplyId;
          const target = answered ? byId.get(answered) : undefined;
          const quoted: QuotedMessage = answered
            ? target
              ? { kind: 'loaded', message: target }
              : { kind: 'unknown' }
            : null;
          return (
            <Fragment key={message.id}>
              {divider ? (
                <li
                  data-chat-divider
                  role="separator"
                  aria-label="New messages"
                  className="my-2 flex items-center gap-2 px-2 text-xs font-semibold text-destructive"
                >
                  <span className="h-px flex-1 bg-destructive/50" aria-hidden="true" />
                  New messages
                  <span className="h-px w-4 bg-destructive/50" aria-hidden="true" />
                </li>
              ) : null}
              <li>
                <ChatMessage
                  message={message}
                  grouped={continuesGroup(messages[index - 1], message, divider)}
                  quoted={quoted}
                  queryKey={queryKey}
                  link={`${window.location.origin}${item.path}#reply-${message.id}`}
                  onReply={setReplyTo}
                  onJumpTo={jumpTo}
                  onMakeTask={makeTask ? makeTaskFromOne : undefined}
                  selecting={selected !== null}
                  selected={selected?.has(message.id) ?? false}
                  onToggleSelected={toggleSelected}
                />
              </li>
            </Fragment>
          );
        })}
      </ol>
    );
  }

  return (
    <div className={cn('flex flex-col gap-2', fill && 'min-h-0 flex-1')} data-testid="chat-view">
      <div className="flex items-center justify-between gap-2">
        <h2 className="flex items-center gap-2 text-sm font-semibold">
          <MessageCircleIcon className="size-4 text-muted-foreground" aria-hidden="true" />
          Chat
          {newest ? (
            <span className="font-normal text-muted-foreground">
              · {pluralize(newest.total, 'message')}
            </span>
          ) : null}
        </h2>
        <div className="flex items-center gap-1">
          {makeTask && messages.length > 0 ? (
            <Button
              variant="ghost"
              size="sm"
              aria-pressed={selected !== null}
              onClick={() => setSelected((current) => (current ? null : new Set()))}
            >
              <ListChecksIcon aria-hidden="true" />
              {selected ? 'Done selecting' : 'Select messages'}
            </Button>
          ) : null}
          <Button variant="ghost" size="sm" onClick={() => setCatchUpOpen(true)}>
            <SparklesIcon aria-hidden="true" />
            Catch up
          </Button>
        </div>
      </div>
      {showStrip && unread ? (
        <div
          className="flex flex-wrap items-center gap-2 rounded-md border border-primary/30 bg-primary/5 px-3 py-2 text-sm"
          data-testid="catch-up-strip"
        >
          <SparklesIcon className="size-4 text-primary" aria-hidden="true" />
          <span className="flex-1">
            You have {pluralize(unread.count, 'unread message')}. Want your agent to catch you up?
          </span>
          <Button size="sm" onClick={() => setCatchUpOpen(true)}>
            Catch up
          </Button>
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label="Hide"
            onClick={() => setStripHidden(true)}
          >
            <XIcon aria-hidden="true" />
          </Button>
        </div>
      ) : null}
      <div className={cn('relative rounded-lg border bg-card', fill && 'min-h-0 flex-1')}>
        <div
          ref={scroller}
          onScroll={onScroll}
          role="log"
          aria-label={`Chat of ${item.ref}`}
          tabIndex={0}
          className={cn(
            'overflow-y-auto px-1 outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50',
            fill ? 'h-full' : 'h-[min(65vh,640px)] min-h-72',
          )}
          data-testid="chat-scroller"
        >
          {/* Few messages sit at the bottom, next to the composer, as in a chat app. */}
          <div className="flex min-h-full flex-col justify-end">{body}</div>
        </div>
        {!atBottom && messages.length > 0 ? (
          <Button
            size="sm"
            variant={unseen > 0 ? 'default' : 'secondary'}
            className="absolute right-3 bottom-3 shadow-md"
            onClick={scrollToEnd}
          >
            <ArrowDownIcon aria-hidden="true" />
            {unseen > 0 ? `${pluralize(unseen, 'new message')}` : 'Jump to latest'}
          </Button>
        ) : null}
      </div>
      <div
        aria-live="polite"
        className="flex min-h-5 flex-wrap items-center gap-x-3 px-1 text-xs text-muted-foreground"
        data-testid="chat-activity"
      >
        {typingLine ? (
          <span className="flex items-center gap-1.5">
            <TypingDots />
            {typingLine}
          </span>
        ) : null}
        {working.map((agent) => (
          <span key={agent.id} className="flex items-center gap-1.5">
            <BotIcon className="size-3.5" aria-hidden="true" />
            {agent.name} is working…
          </span>
        ))}
      </div>
      {/* Requests no message made (an @mention in the description, an assignment). */}
      <ItemAgentRequests item={{ type: parentType, id: parentId }} replyId={null} />
      {selected && makeTask ? (
        <div
          className="flex flex-wrap items-center gap-2 rounded-md border bg-muted/40 px-3 py-2 text-sm"
          data-testid="chat-selection"
        >
          <span className="flex-1" aria-live="polite">
            {selected.size === 0
              ? 'Select the messages to make a task from.'
              : `${pluralize(selected.size, 'message')} selected`}
          </span>
          <Button
            size="sm"
            disabled={selected.size === 0}
            onClick={() => {
              makeTask(messages.filter((message) => selected.has(message.id)));
              setSelected(null);
            }}
          >
            <ListPlusIcon aria-hidden="true" />
            {selected.size > 1
              ? `Make task from ${selected.size} messages`
              : 'Make task from this message'}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setSelected(null)}>
            Cancel
          </Button>
        </div>
      ) : null}
      <ChatComposer
        parentType={parentType}
        parentId={parentId}
        teamId={teamId}
        projectId={projectId}
        placeholder={`Message ${item.ref}`}
        mentionAgents={agents}
        replyTo={replyTo}
        onCancelReply={() => setReplyTo(null)}
        onType={typing.ping}
        onSent={() => {
          setReplyTo(null);
          typing.reset();
          stick.current = true;
        }}
      />
      <CatchUpPanel
        open={catchUpOpen}
        onOpenChange={setCatchUpOpen}
        parentType={parentType}
        parentId={parentId}
        projectId={projectId}
        taskId={parentType === 'task' ? parentId : undefined}
        itemRef={item.ref}
        unread={unread ?? { count: 0, firstReplyId: null }}
      />
    </div>
  );
}

function TypingDots() {
  return (
    <span className="flex gap-0.5" aria-hidden="true">
      {[0, 150, 300].map((delay) => (
        <span
          key={delay}
          className="size-1 animate-bounce rounded-full bg-current motion-reduce:animate-none"
          style={{ animationDelay: `${delay}ms` }}
        />
      ))}
    </span>
  );
}

function ChatSkeleton() {
  return (
    <div role="status" aria-label="Loading the chat" className="space-y-4 p-3">
      {[0, 1, 2, 3].map((row) => (
        <div key={row} className="flex gap-3">
          <Skeleton className="size-8 rounded-full" />
          <div className="flex-1 space-y-1.5">
            <Skeleton className="h-3.5 w-40" />
            <Skeleton className={cn('h-4', row % 2 ? 'w-2/3' : 'w-5/6')} />
          </div>
        </div>
      ))}
    </div>
  );
}
