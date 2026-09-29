import { MessageCircleIcon, MessagesSquareIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { toast } from 'sonner';
import type { ConversationMode, ReplyParentType } from '@shared/constants';
import { ReplyComposer } from '@web/components/replies/ReplyComposer';
import type { ThreadWrite } from '@web/components/replies/threadAgents';
import { Timeline } from '@web/components/replies/Timeline';
import { DropdownMenuItem } from '@web/components/ui/dropdown-menu';
import { errorMessage } from '@web/lib/api';
import { ChatView } from './ChatView';
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
  if (mode === 'chat') {
    return (
      <ChatView
        parentType={parentType}
        parentId={parentId}
        teamId={teamId}
        projectId={projectId}
        item={item}
      />
    );
  }
  return (
    <div className="grid content-start gap-4">
      {forumHeading}
      <Timeline parentType={parentType} parentId={parentId} />
      <ReplyComposer
        parentType={parentType}
        parentId={parentId}
        teamId={teamId}
        projectId={projectId}
        item={item}
      />
    </div>
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
