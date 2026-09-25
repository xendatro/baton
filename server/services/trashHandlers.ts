import type { TrashableType } from '@shared/constants';
import type { Actor, AppDeps } from '../context';
import { deleteAttachment, restoreAttachment } from './attachments';
import { deleteReply, restoreReply } from './replies';

/**
 * How each trashable type is moved to and restored from Trash. The handlers are the modules' own
 * service functions: they check permissions (authors, `DELETE_ANY_CONTENT`, `MANAGE_TRASH`, …),
 * write the audit row and emit live events. Register a type here when its module lands:
 *
 *   task: { softDelete: deleteTask, restore: restoreTask },
 */
export interface TrashHandler {
  softDelete(deps: AppDeps, actor: Actor, id: string): unknown;
  restore(deps: AppDeps, actor: Actor, id: string): unknown;
}

export const trashHandlers: Partial<Record<TrashableType, TrashHandler>> = {
  reply: { softDelete: deleteReply, restore: restoreReply },
  attachment: { softDelete: deleteAttachment, restore: restoreAttachment },
};
