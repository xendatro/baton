import { MessageCircleIcon, MessagesSquareIcon } from 'lucide-react';
import { useMemo, type ReactNode } from 'react';
import { toast } from 'sonner';
import type { ConversationMode, ReplyParentType } from '@shared/constants';
import { ItemAgentRequests } from '@web/components/agentRequests/ItemAgentRequests';
import { ReplyComposer } from '@web/components/replies/ReplyComposer';
import type { ThreadWrite } from '@web/components/replies/threadAgents';
import { Timeline } from '@web/components/replies/Timeline';
import { DropdownMenuItem } from '@web/components/ui/dropdown-menu';
import { errorMessage } from '@web/lib/api';
import { ChatView } from './ChatView';
import { ConversationItemContext, type ConversationItem } from './conversationItem';
import { useSetConversationMode } from './queries';

export interface ConversationProps {
  parentType: ReplyParentType;
  parentId: string;
  teamId: string;
  projectId: string;
  /** Absent (older data): forum. */
  mode: ConversationMode | undefined;
  item: ThreadWrite & { ref: string; path: string };
  /** Heading of the forum view (the chat has its own). */
  forumHeading?: ReactNode;
}

/** An item's conversation in its mode: the chat, or the threaded forum with its reply box. */
export function Conversation({
  parentType,
  parentId,
  teamId,
  projectId,
  mode,
  item,
  forumHeading,
}: ConversationProps) {
  const authorId = item.author?.id ?? null;
  const context = useMemo<ConversationItem>(
    () => ({
      type: parentType,
      id: parentId,
      ref: item.ref,
      path: item.path,
      teamId,
      projectId,
      authorId,
    }),
    [parentType, parentId, item.ref, item.path, teamId, projectId, authorId],
  );
  if (mode === 'chat') {
    return (
      <ConversationItemContext.Provider value={context}>
        <ChatView
          parentType={parentType}
          parentId={parentId}
          teamId={teamId}
          projectId={projectId}
          item={item}
        />
      </ConversationItemContext.Provider>
    );
  }
  return (
    <ConversationItemContext.Provider value={context}>
      <div className="grid content-start gap-4">
        {forumHeading}
        {/* Requests not asked by a reply (an @mention in the description, an assignment). */}
        <ItemAgentRequests item={{ type: parentType, id: parentId }} replyId={null} />
        <Timeline parentType={parentType} parentId={parentId} />
        <ReplyComposer
          parentType={parentType}
          parentId={parentId}
          teamId={teamId}
          projectId={projectId}
          item={item}
        />
      </div>
    </ConversationItemContext.Provider>
  );
}

/**
 * "Switch to chat / forum" in an item's actions menu (its author, or `EDIT_ANY_CONTENT`). The
 * replies stay the same; only how they are shown changes.
 */
export function ConversationModeMenuItem({
  parentType,
  parentId,
  projectId,
  mode,
}: {
  parentType: ReplyParentType;
  parentId: string;
  projectId: string;
  mode: ConversationMode | undefined;
}) {
  const change = useSetConversationMode(parentType, parentId, projectId);
  const next: ConversationMode = mode === 'chat' ? 'forum' : 'chat';
  return (
    <DropdownMenuItem
      onSelect={() =>
        change.mutate(next, {
          onSuccess: () =>
            toast.success(
              next === 'chat' ? 'Conversation is now a chat' : 'Conversation is now a forum',
            ),
          onError: (error) => toast.error(errorMessage(error, 'Couldn’t change it.')),
        })
      }
    >
      {next === 'chat' ? (
        <MessageCircleIcon aria-hidden="true" />
      ) : (
        <MessagesSquareIcon aria-hidden="true" />
      )}
      {next === 'chat' ? 'Switch to chat' : 'Switch to forum'}
    </DropdownMenuItem>
  );
}
