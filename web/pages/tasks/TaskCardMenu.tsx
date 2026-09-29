import { useQueryClient } from '@tanstack/react-query';
import {
  ArrowRightIcon,
  ExternalLinkIcon,
  HandIcon,
  HashIcon,
  LinkIcon,
  SquareArrowOutUpRightIcon,
  Trash2Icon,
  UndoIcon,
  UserPlusIcon,
} from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router';
import { toast } from 'sonner';
import type { Status } from '@shared/schemas/projects';
import type { TaskCard } from '@shared/schemas/tasks';
import { ConfirmDialog } from '@web/components/common/ConfirmDialog';
import { StatusIcon } from '@web/components/common/StatusBadge';
import { MenuRow } from '@web/components/layout/SidebarMenus';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from '@web/components/ui/context-menu';
import { errorMessage } from '@web/lib/api';
import { useMe } from '@web/lib/auth';
import { canOpenNewTab, copyLink, copyToClipboard, openInNewTab } from '@web/lib/links';
import { useProjectAccess } from '@web/lib/permissions';
import type { DifficultyLevel } from './DifficultySelect';
import { boardMoves } from './helpers';
import {
  restoreDeletedTask,
  useClaimAction,
  useDeleteTask,
  useMoveTask,
  useToggleAssignee,
} from './queries';
import { SendBackDialog } from './SendBackDialog';

/**
 * A task's right-click menu on the board and in the list: open it (here or in a new tab), copy
 * its link or ref, move it along its pipeline (the next stage, or back with a reason: the strict
 * moves of BAT-27), assign it to yourself, claim it, delete it (with confirmation and Undo).
 * Wraps the card or row; a normal click still opens the task, and the Menu key / Shift+F10 on the
 * focused card opens the menu too.
 */
export function TaskContextMenu({
  task,
  statuses,
  difficulties,
  disabled = false,
  children,
}: {
  task: TaskCard;
  /** The stages shown (the board's columns, the list's statuses), for Move to. */
  statuses: readonly Status[];
  difficulties?: readonly DifficultyLevel[] | undefined;
  /** While the card is dragged: no menu (a touch hold picks it up). */
  disabled?: boolean;
  children: ReactNode;
}) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const me = useMe().data;
  const access = useProjectAccess(task.teamId, task.projectId);
  const move = useMoveTask(task.projectId);
  const remove = useDeleteTask(task.projectId);
  const claim = useClaimAction(task);
  const assign = useToggleAssignee(task);
  const [sendingBack, setSendingBack] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const viewerId = me?.user.id ?? null;
  const canMove = access.has('UPDATE_TASKS');
  const moves = boardMoves(statuses, task.status.id);
  const next = moves?.next ?? null;
  const back = moves?.back ?? [];
  const assigned = task.assignees.users.some((user) => user.id === viewerId);
  const claimedByMe = task.claim?.user.id === viewerId;

  const moveForward = (status: Status) =>
    move.mutate(
      { taskId: task.id, statusId: status.id, index: Number.MAX_SAFE_INTEGER },
      {
        onSuccess: () => toast.success(`Moved ${task.ref} to ${status.name}`),
        onError: (error) => toast.error(errorMessage(error, 'Couldn’t move the task.')),
      },
    );

  const deleteTask = async () => {
    await remove.mutateAsync(task.id);
    toast.success(`Deleted ${task.ref}`, {
      description: 'It is in the team’s Trash for 30 days.',
      action: {
        label: 'Undo',
        onClick: () => {
          restoreDeletedTask(queryClient, task).then(
            (restored) => toast.success(`Restored ${restored.ref}`),
            (error: unknown) => toast.error(errorMessage(error, 'Couldn’t restore the task.')),
          );
        },
      },
    });
  };

  const claimTask = () =>
    claim.mutate(claimedByMe ? { kind: 'release' } : { kind: 'claim' }, {
      onSuccess: () =>
        toast.success(claimedByMe ? `Released ${task.ref}` : `You claimed ${task.ref}`),
      onError: (error) => toast.error(errorMessage(error, 'Couldn’t change the claim.')),
    });

  const assignToMe = () => {
    if (!me) return;
    assign.mutate(
      {
        kind: 'user',
        add: true,
        assignee: {
          id: me.user.id,
          username: me.user.username ?? '',
          name: me.user.name,
          image: me.user.image,
        },
      },
      {
        onSuccess: () => toast.success(`Assigned ${task.ref} to you`),
        onError: (error) => toast.error(errorMessage(error, 'Couldn’t assign the task.')),
      },
    );
  };

  return (
    <>
      <ContextMenu>
        <ContextMenuTrigger asChild disabled={disabled}>
          {children}
        </ContextMenuTrigger>
        <ContextMenuContent className="w-56" aria-label={`${task.ref} actions`}>
          <ContextMenuLabel className="truncate text-xs font-normal text-muted-foreground">
            {task.ref} · {task.title}
          </ContextMenuLabel>
          <MenuRow
            icon={SquareArrowOutUpRightIcon}
            label="Open"
            shortcut="enter"
            onSelect={() => void navigate(task.path)}
          />
          {canOpenNewTab() ? (
            <MenuRow
              icon={ExternalLinkIcon}
              label="Open in new tab"
              onSelect={() => openInNewTab(task.path, (path) => void navigate(path))}
            />
          ) : null}
          <MenuRow icon={LinkIcon} label="Copy link" onSelect={() => copyLink(task.path)} />
          <MenuRow
            icon={HashIcon}
            label="Copy ref"
            onSelect={() => void copyToClipboard(task.ref, 'Ref')}
          />
          {canMove && (next || back.length > 0) ? (
            <>
              <ContextMenuSeparator />
              <ContextMenuSub>
                <ContextMenuSubTrigger>
                  <ArrowRightIcon aria-hidden="true" />
                  Move to
                </ContextMenuSubTrigger>
                <ContextMenuSubContent className="w-52">
                  {next ? (
                    <ContextMenuItem onSelect={() => moveForward(next)}>
                      <StatusIcon status={next} />
                      <span className="truncate">{next.name}</span>
                      <span className="ml-auto text-xs text-muted-foreground">Next</span>
                    </ContextMenuItem>
                  ) : null}
                  {next && back.length > 0 ? <ContextMenuSeparator /> : null}
                  {back.map((status) => (
                    <ContextMenuItem key={status.id} onSelect={() => setSendingBack(status.id)}>
                      <UndoIcon aria-hidden="true" />
                      <span className="truncate">{status.name}</span>
                      <span className="ml-auto text-xs text-muted-foreground">Back…</span>
                    </ContextMenuItem>
                  ))}
                </ContextMenuSubContent>
              </ContextMenuSub>
            </>
          ) : null}
          {canMove && !assigned && viewerId ? (
            <MenuRow icon={UserPlusIcon} label="Assign to me" onSelect={assignToMe} />
          ) : null}
          {!task.claim || claimedByMe ? (
            <MenuRow
              icon={HandIcon}
              label={claimedByMe ? 'Release claim' : 'Claim'}
              onSelect={claimTask}
            />
          ) : null}
          <ContextMenuSeparator />
          <MenuRow
            icon={Trash2Icon}
            label="Delete…"
            destructive
            onSelect={() => setConfirmDelete(true)}
          />
        </ContextMenuContent>
      </ContextMenu>
      {sendingBack ? (
        <SendBackDialog
          open
          onOpenChange={(open) => (open ? undefined : setSendingBack(null))}
          from={task.status.name}
          stages={back.map((status) => ({
            id: status.id,
            name: status.name,
            difficultyId: status.defaultDifficultyId ?? task.difficulty?.id ?? null,
          }))}
          initialStageId={sendingBack}
          difficulties={difficulties?.length ? difficulties : undefined}
          onConfirm={({ statusId, reason, difficultyId }) =>
            move
              .mutateAsync({
                taskId: task.id,
                statusId,
                index: Number.MAX_SAFE_INTEGER,
                reason,
                ...(difficultyId !== undefined ? { difficultyId } : {}),
              })
              .then((updated) => {
                toast.success(`Sent ${task.ref} back to ${updated.status.name}`);
              })
          }
        />
      ) : null}
      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title={`Delete ${task.ref}?`}
        description="It moves to the team’s Trash, where it can be restored for 30 days. Its claim is released, agents working on it are stopped and their jobs cancelled, and tasks it blocks stop waiting for it."
        confirmLabel="Delete task"
        destructive
        onConfirm={deleteTask}
      />
    </>
  );
}
