import { createContext, useCallback, useContext } from 'react';
import type { ReplyParentType } from '@shared/constants';
import type { Reply } from '@shared/schemas/core';
import { useProjectAccess } from '@web/lib/permissions';
import { runShellAction, useShellActionAvailable } from '@web/lib/shellActions';
import { prefillFromMessages } from '@web/lib/taskPrefill';

/**
 * The item a conversation (chat or forum) belongs to, for what its messages offer beyond the
 * message itself: "Make task from this" and the agent request lines under the message that asked.
 * Provided by `Conversation`; absent elsewhere (a reply shown out of its conversation).
 */
export interface ConversationItem {
  type: ReplyParentType;
  id: string;
  ref: string;
  /** Relative app path. */
  path: string;
  teamId: string;
  projectId: string;
  authorId: string | null;
}

export const ConversationItemContext = createContext<ConversationItem | null>(null);

export function useConversationItem(): ConversationItem | null {
  return useContext(ConversationItemContext);
}

/**
 * "Make task from this": opens the New task dialog prefilled from the messages (and, in an
 * issue's conversation, linked to the issue). Null when the viewer can't create tasks here.
 */
export function useMakeTask(): ((messages: readonly Reply[]) => void) | null {
  const item = useConversationItem();
  const access = useProjectAccess(item?.teamId ?? '', item?.projectId ?? '');
  const available = useShellActionAvailable('task.create');
  const canCreate = item !== null && available && access.has('CREATE_TASKS');
  const canTriage =
    item !== null &&
    ((item.authorId !== null && item.authorId === access.userId) || access.has('RESOLVE_ISSUES'));
  const make = useCallback(
    (messages: readonly Reply[]) => {
      if (!item || messages.length === 0) return;
      runShellAction('task.create', {
        projectId: item.projectId,
        prefill: prefillFromMessages(
          {
            type: item.type,
            id: item.id,
            ref: item.ref,
            path: item.path,
            issueKind: canTriage ? 'fixes' : 'relates',
          },
          messages,
        ),
      });
    },
    [item, canTriage],
  );
  return canCreate ? make : null;
}
