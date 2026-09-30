import { useQueryClient } from '@tanstack/react-query';
import {
  ArrowRightIcon,
  ExternalLinkIcon,
  FlagIcon,
  HandIcon,
  HashIcon,
  LinkIcon,
  MoreHorizontalIcon,
  PencilIcon,
  SquareArrowOutUpRightIcon,
  Trash2Icon,
  UndoIcon,
  UserPlusIcon,
  UsersIcon,
  type LucideIcon,
} from 'lucide-react';
import { useId, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { useNavigate } from 'react-router';
import { toast } from 'sonner';
import { LIMITS, PRIORITIES, type PriorityValue } from '@shared/constants';
import { titleSchema } from '@shared/schemas/common';
import type { Status } from '@shared/schemas/projects';
import type { TaskCard } from '@shared/schemas/tasks';
import { ConfirmDialog } from '@web/components/common/ConfirmDialog';
import { PriorityIcon } from '@web/components/common/PriorityIcon';
import { RoleChip } from '@web/components/common/RoleChip';
import { StatusIcon } from '@web/components/common/StatusBadge';
import { UserAvatar } from '@web/components/common/UserAvatar';
import type { AssigneeToggle } from '@web/components/pickers/AssigneePicker';
import { Button } from '@web/components/ui/button';
import {
  ContextMenu,
  ContextMenuCheckboxItem,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuRadioGroup,
  ContextMenuRadioItem,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from '@web/components/ui/context-menu';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@web/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@web/components/ui/dropdown-menu';
import { Input } from '@web/components/ui/input';
import { Label as FieldLabel } from '@web/components/ui/label';
import { errorMessage } from '@web/lib/api';
import { useMe } from '@web/lib/auth';
import { hotkeyLabels } from '@web/lib/hotkeys';
import { canOpenNewTab, copyLink, copyToClipboard, openInNewTab } from '@web/lib/links';
import { useProjectAccess } from '@web/lib/permissions';
import { cn } from '@web/lib/utils';
import { boardMoves } from './helpers';
import {
  restoreDeletedTask,
  useAssignables,
  useClaimAction,
  useDeleteTask,
  useMoveTask,
  useToggleAssignee,
  useUpdateTask,
} from './queries';
import { SendBackDialog } from './SendBackDialog';
import { useTaskLabelsMenu } from './taskLabelsMenu';

/**
 * A task's actions: open it (here or in a new tab), copy its link or ref, move it along its
 * pipeline (the next stage, or back with a reason: the strict moves of BAT-27), rename it, set its
 * priority, add or remove assignees and labels (BAT-40), assign it to yourself, claim it, delete
 * it (with confirmation and Undo).
 *
 * One definition (`useTaskMenu`) renders into both of the task's menus (BAT#33): the right-click
 * menu of a board card or list row, and the "⋯" button in a board card's top-right corner.
 */

/** Which menu the items render into: a right-click menu or a "⋯" dropdown. */
type MenuKind = 'context' | 'dropdown';

const PARTS = {
  context: {
    Item: ContextMenuItem,
    CheckboxItem: ContextMenuCheckboxItem,
    RadioGroup: ContextMenuRadioGroup,
    RadioItem: ContextMenuRadioItem,
    Label: ContextMenuLabel,
    Separator: ContextMenuSeparator,
    Shortcut: ContextMenuShortcut,
    Sub: ContextMenuSub,
    SubTrigger: ContextMenuSubTrigger,
    SubContent: ContextMenuSubContent,
  },
  dropdown: {
    Item: DropdownMenuItem,
    CheckboxItem: DropdownMenuCheckboxItem,
    RadioGroup: DropdownMenuRadioGroup,
    RadioItem: DropdownMenuRadioItem,
    Label: DropdownMenuLabel,
    Separator: DropdownMenuSeparator,
    Shortcut: DropdownMenuShortcut,
    Sub: DropdownMenuSub,
    SubTrigger: DropdownMenuSubTrigger,
    SubContent: DropdownMenuSubContent,
  },
} as const;

/** Urgent first, like the priority picker. */
const PRIORITY_ORDER = [...PRIORITIES].sort((a, b) => {
  if (a.value === 0) return 1;
  if (b.value === 0) return -1;
  return b.value - a.value;
});

function Row({
  kind,
  icon: Icon,
  label,
  shortcut,
  onSelect,
  destructive = false,
}: {
  kind: MenuKind;
  icon: LucideIcon;
  label: string;
  /** Hotkey syntax (`enter`), shown as a hint. */
  shortcut?: string;
  onSelect: () => void;
  destructive?: boolean;
}) {
  const { Item, Shortcut } = PARTS[kind];
  return (
    <Item onSelect={onSelect} variant={destructive ? 'destructive' : 'default'}>
      <Icon aria-hidden="true" />
      {label}
      {shortcut ? (
        <Shortcut>
          {hotkeyLabels(shortcut)
            .map((caps) => caps.join('+'))
            .join(' ')}
        </Shortcut>
      ) : null}
    </Item>
  );
}

/**
 * The task's menu items for either menu (`items(kind)`), and the dialogs they open (render
 * `dialogs` outside the menus: a menu closes before its dialog opens).
 */
function useTaskMenu(
  task: TaskCard,
  statuses: readonly Status[],
): { items: (kind: MenuKind) => ReactNode; dialogs: ReactNode } {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const me = useMe().data;
  const access = useProjectAccess(task.teamId, task.projectId);
  const move = useMoveTask(task.projectId);
  const remove = useDeleteTask(task.projectId);
  const claim = useClaimAction(task);
  const assign = useToggleAssignee(task);
  const update = useUpdateTask(task);
  const [sendingBack, setSendingBack] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [renaming, setRenaming] = useState(false);

  const viewerId = me?.user.id ?? null;
  const canUpdate = access.has('UPDATE_TASKS');
  const moves = boardMoves(statuses, task.status.id);
  const next = moves?.next ?? null;
  const back = moves?.back ?? [];
  const assigned = task.assignees.users.some((user) => user.id === viewerId);
  const claimedByMe = task.claim?.user.id === viewerId;
  const contextLabels = useTaskLabelsMenu(task, 'context', canUpdate);
  const dropdownLabels = useTaskLabelsMenu(task, 'dropdown', canUpdate);

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

  const toggleAssignee = (toggle: AssigneeToggle) =>
    assign.mutate(toggle, {
      onError: (error) =>
        toast.error(
          errorMessage(
            error,
            `Couldn’t ${toggle.add ? 'assign' : 'unassign'} ${toggle.assignee.name}.`,
          ),
        ),
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

  const setPriority = (priority: PriorityValue) => {
    if (priority === task.priority) return;
    update.mutate(
      { input: { priority }, optimistic: { priority } },
      {
        onError: (error) => toast.error(errorMessage(error, 'Couldn’t change the priority.')),
      },
    );
  };

  const rename = (title: string) => {
    if (title === task.title) return;
    update.mutate(
      { input: { title }, optimistic: { title } },
      {
        onError: (error) => toast.error(errorMessage(error, `Couldn’t rename ${task.ref}.`)),
      },
    );
  };

  const items = (kind: MenuKind) => {
    const { Item, Label, Separator, Sub, SubTrigger, SubContent, RadioGroup, RadioItem } =
      PARTS[kind];
    const labels = kind === 'context' ? contextLabels : dropdownLabels;
    return (
      <>
        <Label className="truncate text-xs font-normal text-muted-foreground">
          {task.ref} · {task.title}
        </Label>
        <Row
          kind={kind}
          icon={SquareArrowOutUpRightIcon}
          label="Open"
          shortcut="enter"
          onSelect={() => void navigate(task.path)}
        />
        {canOpenNewTab() ? (
          <Row
            kind={kind}
            icon={ExternalLinkIcon}
            label="Open in new tab"
            onSelect={() => openInNewTab(task.path, (path) => void navigate(path))}
          />
        ) : null}
        <Row kind={kind} icon={LinkIcon} label="Copy link" onSelect={() => copyLink(task.path)} />
        <Row
          kind={kind}
          icon={HashIcon}
          label="Copy ref"
          onSelect={() => void copyToClipboard(task.ref, 'Ref')}
        />
        {canUpdate ? (
          <>
            <Separator />
            <Row kind={kind} icon={PencilIcon} label="Rename…" onSelect={() => setRenaming(true)} />
          </>
        ) : null}
        {canUpdate && (next || back.length > 0) ? (
          <Sub>
            <SubTrigger className="gap-2">
              <ArrowRightIcon aria-hidden="true" />
              Move to
            </SubTrigger>
            <SubContent className="w-52">
              {next ? (
                <Item onSelect={() => moveForward(next)}>
                  <StatusIcon status={next} />
                  <span className="truncate">{next.name}</span>
                  <span className="ml-auto text-xs text-muted-foreground">Next</span>
                </Item>
              ) : null}
              {next && back.length > 0 ? <Separator /> : null}
              {back.map((status) => (
                <Item key={status.id} onSelect={() => setSendingBack(status.id)}>
                  <UndoIcon aria-hidden="true" />
                  <span className="truncate">{status.name}</span>
                  <span className="ml-auto text-xs text-muted-foreground">Back…</span>
                </Item>
              ))}
            </SubContent>
          </Sub>
        ) : null}
        {canUpdate ? (
          <Sub>
            <SubTrigger className="gap-2">
              <FlagIcon aria-hidden="true" />
              Priority
            </SubTrigger>
            <SubContent className="w-48" aria-label="Priority">
              <RadioGroup
                value={String(task.priority)}
                onValueChange={(value) => setPriority(Number(value) as PriorityValue)}
              >
                {PRIORITY_ORDER.map((priority) => (
                  <RadioItem key={priority.value} value={String(priority.value)}>
                    <PriorityIcon value={priority.value} showLabel />
                  </RadioItem>
                ))}
              </RadioGroup>
            </SubContent>
          </Sub>
        ) : null}
        {canUpdate ? (
          <Sub>
            <SubTrigger className="gap-2">
              <UsersIcon aria-hidden="true" />
              Assign
            </SubTrigger>
            <SubContent className="max-h-80 w-56 overflow-y-auto" aria-label="Assignees">
              <AssigneeItems
                kind={kind}
                task={task}
                viewerId={viewerId}
                onToggle={toggleAssignee}
              />
            </SubContent>
          </Sub>
        ) : null}
        {labels.submenu}
        {canUpdate && !assigned && viewerId ? (
          <Row kind={kind} icon={UserPlusIcon} label="Assign to me" onSelect={assignToMe} />
        ) : null}
        {!task.claim || claimedByMe ? (
          <Row
            kind={kind}
            icon={HandIcon}
            label={claimedByMe ? 'Release claim' : 'Claim'}
            onSelect={claimTask}
          />
        ) : null}
        <Separator />
        <Row
          kind={kind}
          icon={Trash2Icon}
          label="Delete…"
          destructive
          onSelect={() => setConfirmDelete(true)}
        />
      </>
    );
  };

  const dialogs = (
    <>
      {sendingBack ? (
        <SendBackDialog
          open
          onOpenChange={(open) => (open ? undefined : setSendingBack(null))}
          from={task.status.name}
          stages={back.map((status) => ({ id: status.id, name: status.name }))}
          initialStageId={sendingBack}
          onConfirm={({ statusId, reason }) =>
            move
              .mutateAsync({
                taskId: task.id,
                statusId,
                index: Number.MAX_SAFE_INTEGER,
                reason,
              })
              .then((updated) => {
                toast.success(`Sent ${task.ref} back to ${updated.status.name}`);
              })
          }
        />
      ) : null}
      {contextLabels.dialog}
      {dropdownLabels.dialog}
      <RenameTaskDialog open={renaming} onOpenChange={setRenaming} task={task} onRename={rename} />
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

  return { items, dialogs };
}

/**
 * "Assign ›": the team's people (you first) and roles as checkable items; each check adds or
 * removes that assignee of the current stage at once, and the submenu stays open for the next.
 * The team's members and roles load when the submenu first opens.
 */
function AssigneeItems({
  kind,
  task,
  viewerId,
  onToggle,
}: {
  kind: MenuKind;
  task: TaskCard;
  viewerId: string | null;
  onToggle: (toggle: AssigneeToggle) => void;
}) {
  const { CheckboxItem, Item, Label, Separator } = PARTS[kind];
  const people = useAssignables(task.teamId);
  if (people.isPending) return <Item disabled>Loading people…</Item>;
  const users = [...people.users].sort((a, b) =>
    a.id === viewerId ? -1 : b.id === viewerId ? 1 : a.name.localeCompare(b.name),
  );
  const userIds = new Set(task.assignees.users.map((user) => user.id));
  const roleIds = new Set(task.assignees.roles.map((role) => role.id));
  const keepOpen = (event: Event) => event.preventDefault();
  return (
    <>
      <Label className="text-xs font-normal text-muted-foreground">In {task.status.name}</Label>
      {users.length === 0 ? <Item disabled>No people</Item> : null}
      {users.map((user) => (
        <CheckboxItem
          key={user.id}
          checked={userIds.has(user.id)}
          onSelect={keepOpen}
          onCheckedChange={(on) => onToggle({ kind: 'user', assignee: user, add: on === true })}
        >
          <UserAvatar user={user} size="xs" />
          <span className="truncate">
            {user.name}
            {user.id === viewerId ? ' (you)' : ''}
          </span>
        </CheckboxItem>
      ))}
      {people.roles.length > 0 ? (
        <>
          <Separator />
          {people.roles.map((role) => (
            <CheckboxItem
              key={role.id}
              checked={roleIds.has(role.id)}
              onSelect={keepOpen}
              onCheckedChange={(on) => onToggle({ kind: 'role', assignee: role, add: on === true })}
            >
              <RoleChip role={role} className="max-w-40" />
            </CheckboxItem>
          ))}
        </>
      ) : null}
    </>
  );
}

/** Rename…: the title in a small dialog, validated like the task page's title. */
function RenameTaskDialog({
  open,
  onOpenChange,
  task,
  onRename,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  task: Pick<TaskCard, 'ref' | 'title'>;
  onRename: (title: string) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        {open ? (
          <RenameForm task={task} onRename={onRename} onDone={() => onOpenChange(false)} />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function RenameForm({
  task,
  onRename,
  onDone,
}: {
  task: Pick<TaskCard, 'ref' | 'title'>;
  onRename: (title: string) => void;
  onDone: () => void;
}) {
  const id = useId();
  const [title, setTitle] = useState(task.title);
  const [error, setError] = useState<string | null>(null);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const parsed = titleSchema.safeParse(title);
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? 'Enter a title.');
      return;
    }
    // Optimistic: the card shows the new title at once, and a failure puts it back with a toast.
    onRename(parsed.data);
    onDone();
  };

  return (
    <form onSubmit={submit} className="grid gap-4" noValidate>
      <DialogHeader>
        <DialogTitle>Rename {task.ref}</DialogTitle>
        <DialogDescription className="sr-only">Give the task a new title.</DialogDescription>
      </DialogHeader>
      <div className="grid gap-1.5">
        <FieldLabel htmlFor={`${id}-title`}>Title</FieldLabel>
        <Input
          id={`${id}-title`}
          value={title}
          onChange={(event) => {
            setTitle(event.target.value);
            setError(null);
          }}
          maxLength={LIMITS.title.max}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? `${id}-error` : undefined}
          autoFocus
          onFocus={(event) => event.currentTarget.select()}
        />
        {error ? (
          <p id={`${id}-error`} role="alert" className="text-xs text-destructive">
            {error}
          </p>
        ) : null}
      </div>
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit">Rename</Button>
      </DialogFooter>
    </form>
  );
}

/**
 * Wraps a task card or list row in its right-click menu: a normal click still opens the task, and
 * the Menu key / Shift+F10 on the focused card opens the menu too. With `actionsButton` (board
 * cards, BAT#33) a "⋯" button in the top-right corner opens the same actions: it shows on hover
 * or focus where there is a mouse, and always on touch screens.
 */
export function TaskContextMenu({
  task,
  statuses,
  disabled = false,
  actionsButton = false,
  children,
}: {
  task: TaskCard;
  /** The stages shown (the board's columns, the list's statuses), for Move to. */
  statuses: readonly Status[];
  /** While the card is dragged: no menu (a touch hold picks it up). */
  disabled?: boolean;
  actionsButton?: boolean;
  children: ReactNode;
}) {
  const menu = useTaskMenu(task, statuses);
  // Where the menu has to shift up to fit (a card low on the screen), it opens under the pointer,
  // and Radix would pick the item under the release of the right-click (or touch hold) that opened
  // it. That release is ignored; the next press works as usual.
  const openingPress = useRef(false);
  const onOpenChange = (open: boolean) => {
    openingPress.current = open;
    if (open) {
      window.addEventListener('pointerup', () => (openingPress.current = false), { once: true });
    }
  };
  const contextMenu = (
    <ContextMenu onOpenChange={onOpenChange}>
      <ContextMenuTrigger asChild disabled={disabled}>
        {children}
      </ContextMenuTrigger>
      <ContextMenuContent
        className="w-56"
        aria-label={`${task.ref} actions`}
        onPointerUpCapture={(event) => {
          if (openingPress.current) event.stopPropagation();
        }}
      >
        {menu.items('context')}
      </ContextMenuContent>
    </ContextMenu>
  );
  return (
    <>
      {actionsButton ? (
        <div className="group/card relative">
          {contextMenu}
          {disabled ? null : (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  aria-label={`Actions for ${task.ref}`}
                  className={cn(
                    'absolute top-2 right-2 text-muted-foreground hover:text-foreground',
                    'opacity-0 group-focus-within/card:opacity-100 group-hover/card:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100',
                    '[@media(hover:none)]:opacity-100',
                  )}
                >
                  <MoreHorizontalIcon aria-hidden="true" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-56">
                {menu.items('dropdown')}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
      ) : (
        contextMenu
      )}
      {menu.dialogs}
    </>
  );
}
