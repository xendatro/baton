import { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { useLocation, useNavigate, type To } from 'react-router';
import type { ReplyParentType } from '@shared/constants';
import { REPLY_TREE } from '@shared/schemas/core';
import { useSession } from '@web/lib/auth';
import { readReplyDraft } from '@web/lib/replyDrafts';
import { usePostedReplies } from './postedReplies';
import { useReplies, type ReplyTreeView } from './queries';
import { ancestorIds, buildReplyForest, focusForDeepLink, type ReplyForest } from './threadForest';

/**
 * State of an item's threaded replies (BAT-13): the view loaded for the URL, what the viewer
 * expanded and collapsed, and the context the thread components read.
 */

/** The search parameter of a focused sub-thread ("Continue this thread"). */
export const THREAD_PARAM = 'thread';

const MAX_INCLUDE = REPLY_TREE.maxExpand;

// ---------------------------------------------------------------------------------------------
// State of one item's tree
// ---------------------------------------------------------------------------------------------

function collapsedKey(parentType: ReplyParentType, parentId: string) {
  return `baton:reply-collapsed:${parentType}:${parentId}`;
}

/** Collapsed threads of an item, kept for the tab's session. */
function useCollapsedThreads(parentType: ReplyParentType, parentId: string) {
  const key = collapsedKey(parentType, parentId);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => {
    try {
      const raw = sessionStorage.getItem(key);
      const parsed: unknown = raw ? JSON.parse(raw) : [];
      return new Set(Array.isArray(parsed) ? parsed.filter((id) => typeof id === 'string') : []);
    } catch {
      return new Set();
    }
  });
  useEffect(() => {
    try {
      if (collapsed.size === 0) sessionStorage.removeItem(key);
      else sessionStorage.setItem(key, JSON.stringify([...collapsed]));
    } catch {
      // Storage disabled: collapsing lasts as long as the page.
    }
  }, [key, collapsed]);
  return [collapsed, setCollapsed] as const;
}

/** The `#reply-<id>` the URL points at, if any. */
function hashReplyId(hash: string): string | null {
  if (!hash.startsWith('#reply-')) return null;
  try {
    return decodeURIComponent(hash.slice('#reply-'.length)) || null;
  } catch {
    return null;
  }
}

/** `search` with the focused thread set (or removed, for null). */
export function searchWithThread(search: string, replyId: string | null): string {
  const params = new URLSearchParams(search);
  if (replyId) params.set(THREAD_PARAM, replyId);
  else params.delete(THREAD_PARAM);
  const text = params.toString();
  return text ? `?${text}` : '';
}

export interface ThreadContextValue {
  parentType: ReplyParentType;
  parentId: string;
  collapsed: ReadonlySet<string>;
  toggle: (replyId: string) => void;
  /** The thread the viewer just collapsed or expanded: its toggle takes the focus. */
  toggled: string | null;
  /** Loads the answers of a reply that aren't shown yet. */
  expand: (replyId: string) => void;
  /** The reply whose answers are loading, if any. */
  expanding: string | null;
  /** Link to a sub-thread ("Continue this thread"). */
  threadHref: (replyId: string) => To;
  hasDraft: (replyId: string) => boolean;
}

export const ThreadContext = createContext<ThreadContextValue | null>(null);

export function useThread(): ThreadContextValue {
  const value = useContext(ThreadContext);
  if (!value) throw new Error('Thread components must be inside ReplyTreeProvider');
  return value;
}

/**
 * Loads an item's comment tree for the current URL (`?thread=` focus, `#reply-` target) and holds
 * what the viewer expanded and collapsed. The deep-linked reply's collapsed ancestors are opened,
 * and a reply nested too deeply opens its thread three levels up.
 */
export function useReplyTree(parentType: ReplyParentType, parentId: string) {
  const location = useLocation();
  const navigate = useNavigate();
  const userId = useSession().data?.user.id ?? null;
  const focus = new URLSearchParams(location.search).get(THREAD_PARAM);
  const target = hashReplyId(location.hash);
  const posted = usePostedReplies(parentType, parentId);
  const [limit, setLimit] = useState<number>(REPLY_TREE.limit);
  const [expanded, setExpanded] = useState<readonly string[]>([]);
  const [expanding, setExpanding] = useState<string | null>(null);
  const [stored, setCollapsed] = useCollapsedThreads(parentType, parentId);
  const [toggled, setToggled] = useState<string | null>(null);
  // The link visit (location key + hash) after which the viewer toggled a thread themselves.
  const visit = `${location.key}${location.hash}`;
  const [settledVisit, setSettledVisit] = useState<string | null>(null);

  const include = useMemo(
    () => [...new Set([...(target ? [target] : []), ...posted])].slice(0, MAX_INCLUDE),
    [target, posted],
  );
  const view: ReplyTreeView = { root: focus, limit, expand: expanded, include };
  const query = useReplies(parentType, parentId, view);
  const data = query.isPlaceholderData ? undefined : query.data;
  const forest = useMemo<ReplyForest | null>(
    () => (query.data ? buildReplyForest(query.data.items) : null),
    [query.data],
  );

  // A deep link: open the thread around a reply nested too deeply, and show its collapsed
  // ancestors open, until the viewer collapses or expands a thread themselves.
  const focusTo = data && forest && target ? focusForDeepLink(forest, target) : null;
  const forcedOpen =
    forest && target && settledVisit !== visit ? new Set(ancestorIds(forest, target)) : null;
  const collapsed = forcedOpen ? new Set([...stored].filter((id) => !forcedOpen.has(id))) : stored;
  useEffect(() => {
    if (focusTo) {
      void navigate(
        { search: searchWithThread(location.search, focusTo), hash: location.hash },
        { replace: true },
      );
    }
  }, [focusTo, navigate, location.search, location.hash]);

  const context: ThreadContextValue = {
    parentType,
    parentId,
    collapsed,
    toggle: (replyId) => {
      setToggled(replyId);
      setSettledVisit(visit);
      setCollapsed((current) => {
        // What the viewer sees becomes what is stored: threads a link opened stay open.
        const next = new Set([...current].filter((id) => !forcedOpen?.has(id)));
        if (!next.delete(replyId)) next.add(replyId);
        return next;
      });
    },
    toggled,
    expand: (replyId) => {
      setExpanding(replyId);
      setExpanded((current) =>
        current.includes(replyId) ? current : [...current, replyId].slice(-MAX_INCLUDE),
      );
    },
    // Only while its answers load: the new view shows the previous one meanwhile.
    expanding: query.isFetching && query.isPlaceholderData ? expanding : null,
    threadHref: (replyId) => ({
      pathname: location.pathname,
      search: searchWithThread(location.search, replyId),
    }),
    hasDraft: (replyId) =>
      userId ? readReplyDraft(userId, parentType, parentId, replyId) !== null : false,
  };

  return {
    query,
    forest,
    focus,
    context,
    /** The page may scroll to the `#reply-` target: it is loaded and shown (or never will be). */
    ready: Boolean(data) && !focusTo,
    /** Top-level comments not loaded yet (whole-tree view only). */
    moreComments:
      data && forest && !focus ? Math.max(0, data.topLevelCount - forest.roots.length) : 0,
    loadMoreComments: () =>
      setLimit((current) => Math.min(current + REPLY_TREE.limit, REPLY_TREE.maxLimit)),
    canLoadMore: limit < REPLY_TREE.maxLimit,
  };
}
