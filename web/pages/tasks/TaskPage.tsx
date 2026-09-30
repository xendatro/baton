import { useQueryClient } from '@tanstack/react-query';
import {
  BellIcon,
  BellOffIcon,
  CalendarIcon,
  ChevronRightIcon,
  CircleIcon,
  CopyIcon,
  HandIcon,
  LinkIcon,
  MoreHorizontalIcon,
  PanelRightIcon,
  PencilIcon,
  SignalHighIcon,
  TagIcon,
  Trash2Icon,
  UsersIcon,
  WorkflowIcon,
} from 'lucide-react';
import { useState, type ComponentProps, type ReactNode } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { toast } from 'sonner';
import { LIMITS, PRIORITIES, type PriorityValue } from '@shared/constants';
import type { Attachment, MeProject, MeTeam } from '@shared/schemas/core';
import type { Task, UpdateTaskInput } from '@shared/schemas/tasks';
import { AttachmentList } from '@web/components/attachments/AttachmentList';
import { AttachmentUploader } from '@web/components/attachments/AttachmentUploader';
import { AgentBadge } from '@web/components/common/AgentBadge';
import { ItemAgentRuns } from '@web/components/agentRuns/ItemAgentRuns';
import { AgentConnectionNotice } from '@web/components/common/AgentConnectionNotice';
import { BackLink } from '@web/components/common/BackLink';
import { ConfirmDialog } from '@web/components/common/ConfirmDialog';
import { DueDate } from '@web/components/common/DueDate';
import { ErrorState } from '@web/components/common/ErrorState';
import { Kbd } from '@web/components/common/Kbd';
import { LabelChip } from '@web/components/common/LabelChip';
import { NotFound } from '@web/components/common/NotFound';
import { PageContainer } from '@web/components/common/PageContainer';
import { ReadMore } from '@web/components/common/ReadMore';
import { ViewportFill } from '@web/components/common/ViewportFill';
import { PriorityIcon } from '@web/components/common/PriorityIcon';
import { RelativeTime } from '@web/components/common/RelativeTime';
import { RoleChip } from '@web/components/common/RoleChip';
import { Spinner } from '@web/components/common/Spinner';
import { StatusBadge } from '@web/components/common/StatusBadge';
import { UserAvatar } from '@web/components/common/UserAvatar';
import { UserName } from '@web/components/common/UserName';
import { WorkingDot } from '@web/components/common/WorkingDot';
import { RichTextEditor } from '@web/components/editor/RichTextEditor';
import { MarkdownView } from '@web/components/markdown/MarkdownView';
import { ReactionBar } from '@web/components/reactions/ReactionBar';
import { usePaletteCommands, type PaletteCommand } from '@web/components/palette/registry';
import { AssigneePicker } from '@web/components/pickers/AssigneePicker';
import { DatePicker } from '@web/components/pickers/DatePicker';
import { LabelPicker } from '@web/components/pickers/LabelPicker';
import { PriorityPicker } from '@web/components/pickers/PriorityPicker';
import { StatusPicker } from '@web/components/pickers/StatusPicker';
import { useDeleteAttachment } from '@web/components/replies/queries';
import { ActivitySheet } from '@web/components/replies/ActivitySheet';
import { Conversation, ConversationModeMenuItem } from '@web/components/chat/Conversation';
import { ItemPageFrame, ItemRailToggle } from '@web/components/itemRail/ItemPageFrame';
import { Button } from '@web/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@web/components/ui/dropdown-menu';
import { Input } from '@web/components/ui/input';
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '@web/components/ui/sheet';
import { Skeleton } from '@web/components/ui/skeleton';
import { isAgentUser } from '@web/lib/agentMembers';
import { errorMessage, isApiError } from '@web/lib/api';
import { useMe } from '@web/lib/auth';
import { useHotkey } from '@web/lib/hotkeys';
import { useBack, type BackOptions } from '@web/lib/navigationHistory';
import { queryKeys } from '@web/lib/queryKeys';
import { useProjectAccess } from '@web/lib/permissions';
import { useRouteContext } from '@web/lib/routeContext';
import { useDocumentTitle } from '@web/lib/title';
import { useMediaQuery } from '@web/lib/useMediaQuery';
import { cn } from '@web/lib/utils';
import { useMarkItemRead } from '../inbox/useMarkItemRead';
import { copyText } from '../teams/clipboard';
import { useCreateLabel, useLabels, usePipelines, useStatuses } from '../projects/queries';
import { pipelineBoardPath } from './pipelineTab';
import { ClaimPanel } from './ClaimPanel';
import { ForceMoveDialog } from './ForceMoveDialog';
import { SendBackDialog, type SendBackResult } from './SendBackDialog';
import { StagePanel } from './StagePanel';
import {
  restoreDeletedTask,
  useAssignables,
  useClaimAction,
  useDeleteTask,
  useTask,
  useStageMove,
  useTaskSubscription,
  useToggleAssignee,
  useUpdateTask,
} from './queries';
import { tasksViewPath, useTaskView } from './filters';
import { projectSettingsPath } from './settingsPaths';
import { TaskRail } from './TaskRail';
import { TaskRelations } from './TaskRelations';

/**
 * A task (`/t/:team/p/:key/tasks/:number`): inline-editable title (`e`), description, files, the
 * replies-and-history timeline with a composer, and a sidebar with the claim, the properties
 * (pickers on `s`, `p`, `a`, `l`), links, and actions (subscribe, copy, delete with undo).
 * "← Board" (or `u`, or Esc) returns to the board or list the task was opened from.
 */
export default function TaskPage() {
  const { team, project } = useRouteContext();
  const params = useParams();
  const number = Number(params.number);
  if (!team || !project) return null;
  const valid = Number.isSafeInteger(number) && number >= 1;
  // BAT-44: the rail stays mounted while the viewer switches tasks (it keeps its scroll).
  return (
    <ItemPageFrame
      label="Tasks"
      rail={<TaskRail team={team} project={project} currentNumber={number} />}
    >
      {valid ? (
        <TaskLoader key={`${project.id}:${number}`} team={team} project={project} number={number} />
      ) : (
        <NotFound what="Task" />
      )}
    </ItemPageFrame>
  );
}

/** The details column sits beside a chat task from here; narrower, it opens as a sheet. */
const DETAILS_BESIDE_QUERY = '(min-width: 1024px)';

function TaskLoader({
  team,
  project,
  number,
}: {
  team: MeTeam;
  project: MeProject;
  number: number;
}) {
  const task = useTask(project.id, number);
  useDocumentTitle(task.data ? [`${task.data.ref} ${task.data.title}`, project.name] : null);
  // Keep showing the task while a refetch fails (e.g. right after deleting it).
  if (task.data) return <TaskView task={task.data} team={team} project={project} />;
  if (task.isError) {
    if (isApiError(task.error) && task.error.status === 404) return <NotFound what="Task" />;
    return (
      <PageContainer>
        <ErrorState
          title="Couldn’t load this task"
          error={task.error}
          onRetry={() => void task.refetch()}
        />
      </PageContainer>
    );
  }
  return <TaskSkeleton team={team} project={project} />;
}

type Picker = 'status' | 'priority' | 'assignees' | 'labels' | 'due' | null;

function TaskView({ task, team, project }: { task: Task; team: MeTeam; project: MeProject }) {
  const me = useMe().data;
  const viewerId = me?.user.id ?? null;
  const access = useProjectAccess(team.id, project.id);
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const statuses = useStatuses(project.id);
  const pipelines = usePipelines(project.id);
  // Whether tasks in the task's stage can be claimed (its `claimable` rule).
  const stageClaimable =
    statuses.data?.find((status) => status.id === task.status.id)?.rules?.claimable ?? true;
  const labels = useLabels(project.id);
  const createLabel = useCreateLabel(project.id);
  const people = useAssignables(team.id);
  const update = useUpdateTask(task);
  const toggleAssignee = useToggleAssignee(task);
  const remove = useDeleteTask(project.id);
  const subscription = useTaskSubscription(task);
  const deleteAttachment = useDeleteAttachment({ type: 'task', id: task.id });
  useMarkItemRead('task', task);
  // Images shown inline in the description aren't listed again as files (as on issues).
  const files = task.attachments.filter(
    (attachment) => !(attachment.isImage && task.description.includes(attachment.url)),
  );
  const refreshTask = () =>
    queryClient.invalidateQueries({
      queryKey: queryKeys.tasks.detail(task.projectId, task.number),
    });
  const claim = useClaimAction(task);

  const isAuthor = task.author?.id === viewerId;
  const canEditText = access.canEdit(task.author?.id);
  const canUpdate = isAuthor || access.has('UPDATE_TASKS');
  // A person and their agent count as one author (the server's rule): I may delete what my agent wrote.
  const byMyAgent = viewerId !== null && task.author?.agentOwner?.id === viewerId;
  const canDelete = byMyAgent || access.canDelete(task.author?.id);
  const [picker, setPicker] = useState<Picker>(null);
  const [editingTitle, setEditingTitle] = useState(false);
  const [editingDescription, setEditingDescription] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  // BAT-43: a chat task is one screen tall; below lg its details open as a sheet.
  const chat = task.conversationMode === 'chat';
  const wide = useMediaQuery(DETAILS_BESIDE_QUERY);
  const detailsInSheet = chat && !wide;
  const [detailsOpen, setDetailsOpen] = useState(false);
  /** A move the stage rules block, which the viewer may force (owner / administrator). */
  const [forcing, setForcing] = useState<{ statusId: string; reason: string } | null>(null);
  /** BAT-27: a status picked from the earlier stages it may go back to (asks for the reason). */
  const [sendingBack, setSendingBack] = useState<string | null>(null);
  const stageMove = useStageMove(task);
  const sendBack = ({ statusId, reason }: SendBackResult) =>
    stageMove
      .mutateAsync({ statusId, reason })
      .then((updated) => toast.success(`Sent back to ${updated.status.name}`));

  const save = (input: UpdateTaskInput, optimistic?: Partial<Task>, success?: string) =>
    update.mutateAsync({ input, optimistic }).then(
      (result) => {
        if (success) toast.success(success);
        return result;
      },
      (error: unknown) => {
        toast.error(errorMessage(error, 'Couldn’t save the change.'));
        throw error;
      },
    );
  const quietly = (promise: Promise<unknown>) => void promise.catch(() => undefined);

  const deleteTask = async () => {
    await remove.mutateAsync(task.id);
    void navigate(`/t/${team.slug}/p/${project.key}/tasks`);
    toast.success(`Deleted ${task.ref}`, {
      description: 'It is in the team’s Trash for 30 days.',
      action: {
        label: 'Undo',
        onClick: () => {
          restoreDeletedTask(queryClient, task).then(
            (restored) => {
              toast.success(`Restored ${restored.ref}`);
              void navigate(restored.path);
            },
            (error: unknown) => toast.error(errorMessage(error, 'Couldn’t restore the task.')),
          );
        },
      },
    });
  };

  const openPicker = (which: Picker) => () => {
    if (detailsInSheet) setDetailsOpen(true);
    setPicker(which);
  };
  useHotkey('s', openPicker('status'), {
    description: 'Change status',
    group: 'Task',
    enabled: canUpdate,
  });
  useHotkey('p', openPicker('priority'), {
    description: 'Change priority',
    group: 'Task',
    enabled: canUpdate,
  });
  useHotkey('a', openPicker('assignees'), {
    description: 'Assign',
    group: 'Task',
    enabled: canUpdate,
  });
  useHotkey('l', openPicker('labels'), {
    description: 'Change labels',
    group: 'Task',
    enabled: canUpdate,
  });
  useHotkey('e', () => setEditingTitle(true), {
    description: 'Edit the title',
    group: 'Task',
    enabled: canEditText && !editingTitle,
  });
  // SPEC §1.9 "Esc close": back to the board or list, with the filters it had. Esc inside a
  // picker, dialog or field closes that instead (hotkeys never fire there).
  const backOptions = useTaskBackOptions(team, project);
  const back = useBack(backOptions);
  useHotkey('escape', back.goBack, {
    description: 'Close the task',
    group: 'Task',
    enabled:
      picker === null &&
      !editingTitle &&
      !editingDescription &&
      !confirmDelete &&
      !forcing &&
      sendingBack === null,
  });

  const url = `${window.location.origin}${task.path}`;
  const claimMine = task.claim?.user.id === viewerId;
  const commands: PaletteCommand[] = [
    ...(canUpdate
      ? [
          {
            id: 'task.status',
            label: `${task.ref}: Change status…`,
            icon: CircleIcon,
            shortcut: 's',
            perform: openPicker('status'),
          },
          {
            id: 'task.priority',
            label: `${task.ref}: Change priority…`,
            icon: SignalHighIcon,
            shortcut: 'p',
            perform: openPicker('priority'),
          },
          {
            id: 'task.assign',
            label: `${task.ref}: Assign…`,
            icon: UsersIcon,
            shortcut: 'a',
            perform: openPicker('assignees'),
          },
          {
            id: 'task.labels',
            label: `${task.ref}: Change labels…`,
            icon: TagIcon,
            shortcut: 'l',
            perform: openPicker('labels'),
          },
          {
            id: 'task.due',
            label: `${task.ref}: Set due date…`,
            icon: CalendarIcon,
            perform: openPicker('due'),
          },
        ].map((command) => ({ ...command, group: 'Task' }))
      : []),
    ...(canEditText
      ? [
          {
            id: 'task.title',
            label: `${task.ref}: Edit title`,
            group: 'Task',
            icon: PencilIcon,
            shortcut: 'e',
            perform: () => setEditingTitle(true),
          },
        ]
      : []),
    ...(canUpdate && !task.claim && stageClaimable
      ? [
          {
            id: 'task.claim',
            label: `${task.ref}: Claim`,
            group: 'Task',
            icon: HandIcon,
            keywords: ['work on', 'start'],
            perform: () =>
              claim.mutate(
                { kind: 'claim' },
                { onSuccess: () => toast.success('You claimed this task') },
              ),
          },
        ]
      : []),
    ...(claimMine
      ? [
          {
            id: 'task.release',
            label: `${task.ref}: Release claim`,
            group: 'Task',
            icon: HandIcon,
            keywords: ['stop', 'unclaim'],
            perform: () =>
              claim.mutate(
                { kind: 'release' },
                { onSuccess: () => toast.success('Claim released') },
              ),
          },
        ]
      : []),
    {
      id: 'task.copy-ref',
      label: `Copy ${task.ref}`,
      group: 'Task',
      icon: CopyIcon,
      keywords: ['copy ref', 'key'],
      perform: () => void copyText(task.ref, task.ref),
    },
    {
      id: 'task.copy-link',
      label: `Copy link to ${task.ref}`,
      group: 'Task',
      icon: LinkIcon,
      keywords: ['copy url'],
      perform: () => void copyText(url),
    },
    {
      id: 'task.subscribe',
      label: task.subscribed ? `Unsubscribe from ${task.ref}` : `Subscribe to ${task.ref}`,
      group: 'Task',
      icon: task.subscribed ? BellOffIcon : BellIcon,
      keywords: ['notifications', 'watch'],
      perform: () => subscription.mutate(!task.subscribed),
    },
    ...(canDelete
      ? [
          {
            id: 'task.delete',
            label: `Delete ${task.ref}`,
            group: 'Task',
            icon: Trash2Icon,
            keywords: ['remove', 'trash'],
            perform: () => setConfirmDelete(true),
          },
        ]
      : []),
  ];
  usePaletteCommands(commands);

  // BAT-25: its own pipeline's stages first, then the other pipelines' (picking one moves it there).
  const ownPipeline = task.status.pipeline?.id;
  const statusList = [...(statuses.data ?? [])].sort(
    (a, b) => Number(b.pipelineId === ownPipeline) - Number(a.pipelineId === ownPipeline),
  );
  const pipelineList = pipelines.data ?? [];
  const pipelineNameOf = (status: { pipelineId?: string }) =>
    pipelineList.find((pipeline) => pipeline.id === status.pipelineId)?.name;
  const labelList = labels.data ?? [];
  const blockedMoves = task.stage?.blockedMoves ?? {};

  /** Changes the status, or explains why the pipeline blocks it (design §5). */
  const changeStatus = (statusId: string) => {
    const next = statusList.find((status) => status.id === statusId);
    if (!next || statusId === task.status.id) return;
    if (task.stage?.canMoveTo?.back.some((stage) => stage.id === statusId)) {
      setSendingBack(statusId);
      return;
    }
    const blocked = blockedMoves[statusId];
    if (blocked) {
      if (task.stage?.canForce) setForcing({ statusId, reason: blocked });
      else toast.error(`Can’t move to ${next.name}: ${blocked}`);
      return;
    }
    quietly(
      save(
        { statusId },
        {
          status: { id: next.id, name: next.name, color: next.color, icon: next.icon },
        },
      ),
    );
  };

  const header = (
    <header
      className={cn('min-w-0', chat ? 'shrink-0 border-b pb-3' : 'lg:col-start-1 lg:row-start-1')}
    >
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <TaskLocation task={task} team={team} project={project} />
          {editingTitle ? (
            <TitleEditor
              initial={task.title}
              pending={update.isPending}
              onCancel={() => setEditingTitle(false)}
              onSave={(title) => {
                if (title === task.title) {
                  setEditingTitle(false);
                  return;
                }
                quietly(save({ title }, { title }).then(() => setEditingTitle(false)));
              }}
            />
          ) : (
            <h1
              className={cn(
                'text-xl leading-tight font-semibold tracking-tight break-words sm:text-2xl',
                canEditText && 'cursor-text rounded-sm hover:bg-muted/60',
              )}
              onDoubleClick={canEditText ? () => setEditingTitle(true) : undefined}
            >
              {task.title}
              <WorkingDot working={task.agentWorking} className="ml-2 align-middle" />
            </h1>
          )}
        </div>
        <ActivitySheet
          parentType="task"
          parentId={task.id}
          itemRef={task.ref}
          group="Task"
          className="mt-4"
        />
        {detailsInSheet ? (
          <Button
            variant="outline"
            size="sm"
            className="mt-4 shrink-0"
            onClick={() => setDetailsOpen(true)}
          >
            <PanelRightIcon aria-hidden="true" />
            Details
          </Button>
        ) : null}
        {canDelete ? <DeleteTaskButton onDelete={() => setConfirmDelete(true)} /> : null}
        <TaskMenu
          task={task}
          canEditText={canEditText}
          canDelete={canDelete}
          onEditTitle={() => setEditingTitle(true)}
          onToggleSubscription={() => subscription.mutate(!task.subscribed)}
          onDelete={() => setConfirmDelete(true)}
          url={url}
        />
      </div>
      <p className="mt-2 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-sm text-muted-foreground">
        <span>Opened by</span>
        <UserName user={task.author} via={task.via} avatar="xs" />
        <RelativeTime value={task.createdAt} />
        {task.editedAt ? <span title="The title or description was edited">· edited</span> : null}
      </p>
    </header>
  );
  const details = (
    <>
      <ClaimPanel
        task={task}
        viewerId={viewerId}
        canClaim={canUpdate || Boolean(task.stage?.pool?.canClaim)}
        canTakeOver={access.has('UPDATE_TASKS')}
        claimable={stageClaimable}
      />
      <dl className="grid grid-cols-1 gap-1">
        <Property label="Status" hotkey="s">
          <StatusPicker
            statuses={statusList}
            value={task.status.id}
            open={picker === 'status'}
            onOpenChange={(open) => setPicker(open ? 'status' : null)}
            disabled={!canUpdate}
            align="end"
            reasons={blockedMoves}
            onChange={changeStatus}
            groupOf={pipelineList.length > 1 ? pipelineNameOf : undefined}
          >
            <PropertyButton disabled={!canUpdate} label={`Status: ${task.status.name}`}>
              <StatusBadge status={task.status} />
            </PropertyButton>
          </StatusPicker>
        </Property>
        {task.status.pipeline ? (
          <Property label="Pipeline">
            <Link
              to={pipelineBoardPath(`/t/${team.slug}/p/${project.key}`, task.status.pipeline.id)}
              className="flex h-8 items-center gap-1.5 rounded-md px-2 text-sm outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
              title={
                pipelineList.length > 1
                  ? 'Its board. Pick a stage of another pipeline to move it there'
                  : 'Its board'
              }
            >
              <WorkflowIcon className="size-3.5 text-muted-foreground" aria-hidden="true" />
              {task.status.pipeline.name}
            </Link>
          </Property>
        ) : null}
        <Property label="Priority" hotkey="p">
          <PriorityPicker
            value={task.priority}
            open={picker === 'priority'}
            onOpenChange={(open) => setPicker(open ? 'priority' : null)}
            disabled={!canUpdate}
            align="end"
            onChange={(priority: PriorityValue) => {
              if (priority !== task.priority) quietly(save({ priority }, { priority }));
            }}
          >
            <PropertyButton
              disabled={!canUpdate}
              label={`Priority: ${PRIORITIES[task.priority]?.label ?? 'No priority'}`}
            >
              <PriorityIcon value={task.priority} showLabel />
            </PropertyButton>
          </PriorityPicker>
        </Property>
        <Property label="Assignees" hotkey="a">
          <AssigneePicker
            users={people.users}
            roles={people.roles}
            currentUserId={viewerId ?? undefined}
            value={{
              userIds: task.assignees.users.map((user) => user.id),
              roleIds: task.assignees.roles.map((role) => role.id),
            }}
            open={picker === 'assignees'}
            onOpenChange={(open) => setPicker(open ? 'assignees' : null)}
            disabled={!canUpdate}
            align="end"
            // Each toggle applies at once as its own add/remove, in the current stage.
            note={`Assigned in ${task.status.name}. Changes apply right away.`}
            onToggle={(toggle) => {
              const pooled = toggle.add && Boolean(task.stage?.pool);
              toggleAssignee.mutateAsync(toggle).then(
                () => {
                  if (pooled) {
                    toast.success(`Assigned ${toggle.assignee.name}`, {
                      description: `${task.ref} no longer waits in the ${task.status.name} pool.`,
                    });
                  }
                },
                (error: unknown) =>
                  toast.error(
                    errorMessage(
                      error,
                      `Couldn’t ${toggle.add ? 'assign' : 'unassign'} ${toggle.assignee.name}.`,
                    ),
                  ),
              );
            }}
          >
            <PropertyButton
              disabled={!canUpdate}
              label={`Assignees: ${assigneeNames(task) || 'none'}`}
            >
              {task.assignees.users.length || task.assignees.roles.length ? (
                <span className="flex min-w-0 flex-wrap items-center gap-1.5">
                  {task.assignees.users.map((user) => (
                    <span key={user.id} className="inline-flex min-w-0 items-center gap-1">
                      <UserAvatar user={user} size="xs" />
                      <span className="truncate">{user.name}</span>
                      {isAgentUser(user) ? <AgentBadge /> : null}
                    </span>
                  ))}
                  {task.assignees.roles.map((role) => (
                    <RoleChip key={role.id} role={role} />
                  ))}
                </span>
              ) : (
                <span className="text-muted-foreground">Unassigned</span>
              )}
            </PropertyButton>
          </AssigneePicker>
          <p className="px-2 text-xs text-muted-foreground">
            {canUpdate
              ? `In ${task.status.name}`
              : `In ${task.status.name}. Only the author or members who can update tasks change assignees.`}
          </p>
        </Property>
        <Property label="Labels" hotkey="l">
          <LabelPicker
            labels={labelList}
            value={task.labels.map((label) => label.id)}
            open={picker === 'labels'}
            onOpenChange={(open) => setPicker(open ? 'labels' : null)}
            disabled={!canUpdate}
            align="end"
            onCreate={
              access.has('MANAGE_LABELS') ? (name) => createLabel.mutateAsync({ name }) : undefined
            }
            manageHref={
              access.has('MANAGE_LABELS')
                ? projectSettingsPath(`/t/${team.slug}/p/${project.key}`, 'labels')
                : undefined
            }
            onChange={(labelIds) =>
              quietly(
                save(
                  { labels: { set: labelIds } },
                  {
                    labels: labelList
                      .filter((label) => labelIds.includes(label.id))
                      .map(({ id, name, color }) => ({ id, name, color })),
                  },
                ),
              )
            }
          >
            <PropertyButton
              disabled={!canUpdate}
              label={`Labels: ${task.labels.map((label) => label.name).join(', ') || 'none'}`}
            >
              {task.labels.length ? (
                <span className="flex flex-wrap gap-1">
                  {task.labels.map((label) => (
                    <LabelChip key={label.id} label={label} />
                  ))}
                </span>
              ) : (
                <span className="text-muted-foreground">No labels</span>
              )}
            </PropertyButton>
          </LabelPicker>
        </Property>
        <Property label="Due date">
          <DatePicker
            value={task.dueDate}
            open={picker === 'due'}
            onOpenChange={(open) => setPicker(open ? 'due' : null)}
            disabled={!canUpdate}
            align="end"
            onChange={(dueDate) => quietly(save({ dueDate }, { dueDate }))}
          >
            <PropertyButton disabled={!canUpdate} label={`Due date: ${task.dueDate ?? 'none'}`}>
              {task.dueDate ? (
                <DueDate
                  value={task.dueDate}
                  done={task.completedAt !== null}
                  className="text-sm"
                />
              ) : (
                <span className="text-muted-foreground">No due date</span>
              )}
            </PropertyButton>
          </DatePicker>
        </Property>
      </dl>
      <div className="border-t pt-4">
        <TaskRelations
          task={task}
          editable={canUpdate}
          onChange={(input) => quietly(save(input))}
        />
      </div>
      <ItemAgentRuns item={{ type: 'task', id: task.id }} className="border-t pt-4" />
      <dl className="grid gap-2 border-t pt-4 text-sm">
        <div className="flex items-center justify-between gap-2">
          <dt className="text-muted-foreground">Created</dt>
          <dd>
            <RelativeTime value={task.createdAt} />
          </dd>
        </div>
        <div className="flex items-center justify-between gap-2">
          <dt className="text-muted-foreground">Updated</dt>
          <dd>
            <RelativeTime value={task.updatedAt} />
          </dd>
        </div>
        {task.completedAt ? (
          <div className="flex items-center justify-between gap-2">
            <dt className="text-muted-foreground">Completed</dt>
            <dd>
              <RelativeTime value={task.completedAt} />
            </dd>
          </div>
        ) : null}
      </dl>
      <div className="grid gap-1.5">
        <Button
          variant="outline"
          size="sm"
          className="justify-self-start"
          aria-pressed={task.subscribed}
          onClick={() => subscription.mutate(!task.subscribed)}
        >
          {task.subscribed ? <BellOffIcon aria-hidden="true" /> : <BellIcon aria-hidden="true" />}
          {task.subscribed ? 'Unsubscribe' : 'Subscribe'}
        </Button>
        <p className="text-xs text-muted-foreground">
          {task.subscribed
            ? 'You’re notified about replies to this task.'
            : 'You’re not notified about replies to this task.'}
        </p>
      </div>
    </>
  );
  const notice = (
    <AgentConnectionNotice
      projectId={task.projectId}
      taskId={task.id}
      when={(connection) => connection.taskInvolvesAgent === true}
      waitingNote={(connection) =>
        connection.pendingJobsForTask
          ? `${connection.pendingJobsForTask} job${connection.pendingJobsForTask === 1 ? '' : 's'} for your agent on this task.`
          : null
      }
      dismissKey="task"
      className={chat ? undefined : 'mb-4 lg:mt-6 lg:mb-0'}
    />
  );
  const stagePanel = task.stage ? (
    <StagePanel
      task={{ ...task, stage: task.stage }}
      teamId={team.id}
      // Also while the shown status is ahead of the stage (an optimistic move): the
      // stage's buttons would act on the stage the task is leaving.
      moving={update.isPending || task.status.id !== task.stage.status.id}
      onMoveOn={
        task.stage.next ? () => changeStatus(task.stage?.next?.id ?? task.status.id) : undefined
      }
      onSendBack={canUpdate || task.stage.approvals?.canApprove ? sendBack : undefined}
    />
  ) : null;
  const description = (
    <section
      aria-labelledby="description-heading"
      className={chat ? undefined : cn(task.stage ? 'mt-6' : 'lg:mt-6')}
    >
      <div className="mb-2 flex items-center justify-between gap-2">
        <h2 id="description-heading" className="text-sm font-semibold">
          Description
        </h2>
        {canEditText && !editingDescription ? (
          <Button variant="ghost" size="sm" onClick={() => setEditingDescription(true)}>
            <PencilIcon aria-hidden="true" />
            Edit
          </Button>
        ) : null}
      </div>
      {editingDescription ? (
        <DescriptionEditor
          teamId={team.id}
          initial={task.description}
          pending={update.isPending}
          onCancel={() => setEditingDescription(false)}
          onSave={(description, attachmentIds) =>
            quietly(
              save(
                {
                  description,
                  ...(attachmentIds.length ? { attachmentIds } : {}),
                },
                undefined,
                'Description saved',
              ).then(() => setEditingDescription(false)),
            )
          }
        />
      ) : task.description.trim() ? (
        <MarkdownView markdown={task.description} teamId={team.id} />
      ) : (
        <p className="rounded-lg border border-dashed px-3 py-4 text-sm text-muted-foreground">
          No description.
          {canEditText ? ' Add one to give agents and teammates the full context.' : ''}
        </p>
      )}
      {editingDescription ? null : (
        <ReactionBar
          targetType="task"
          targetId={task.id}
          teamId={team.id}
          projectId={task.projectId}
          reactions={task.reactions}
          queryKey={queryKeys.tasks.detail(task.projectId, task.number)}
          className="mt-3"
        />
      )}
    </section>
  );
  const filesSection = (
    <section aria-labelledby="files-heading" className={chat ? 'mt-4' : 'mt-6'}>
      <div className="mb-2 flex items-center justify-between gap-2">
        <h2 id="files-heading" className="text-sm font-semibold">
          Files
        </h2>
        {canEditText || canUpdate ? (
          <AttachmentUploader
            teamId={team.id}
            parentType="task"
            parentId={task.id}
            onUploaded={() => void refreshTask()}
          />
        ) : null}
      </div>
      {files.length ? (
        <AttachmentList
          attachments={files}
          canDelete={(attachment) => access.canDelete(attachment.uploader?.id)}
          onDelete={(attachment) =>
            deleteAttachment.mutateAsync(attachment.id).then(() => {
              void refreshTask();
              toast.success(`Moved ${attachment.filename} to Trash`);
            })
          }
        />
      ) : (
        <p className="text-sm text-muted-foreground">No files.</p>
      )}
    </section>
  );
  const conversation = (
    <Conversation
      parentType="task"
      parentId={task.id}
      teamId={team.id}
      projectId={task.projectId}
      mode={task.conversationMode}
      item={task}
      fill={chat}
      forumHeading={<h2 className="text-sm font-semibold">Conversation</h2>}
    />
  );
  const dialogs = (
    <>
      <ForceMoveDialog
        open={forcing !== null}
        onOpenChange={(open) => (open ? undefined : setForcing(null))}
        target={statusList.find((status) => status.id === forcing?.statusId)?.name ?? ''}
        blockedBy={forcing?.reason ?? ''}
        onConfirm={(reason) =>
          save(
            { statusId: forcing?.statusId ?? task.status.id, force: true, reason },
            undefined,
            'Moved past the stage rules',
          ).then(() => setForcing(null))
        }
      />
      <SendBackDialog
        open={sendingBack !== null}
        onOpenChange={(open) => (open ? undefined : setSendingBack(null))}
        from={task.status.name}
        stages={task.stage?.canMoveTo?.back ?? []}
        initialStageId={sendingBack ?? undefined}
        onConfirm={sendBack}
      />
      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title={`Delete ${task.ref}?`}
        description={
          <>
            It moves to the team’s Trash, where it can be restored for 30 days. Its claim is
            released, agents working on it are stopped and their jobs cancelled, and tasks it blocks
            stop waiting for it.
          </>
        }
        confirmLabel="Delete task"
        destructive
        onConfirm={deleteTask}
      />
    </>
  );

  if (chat) {
    // BAT-43: exactly one screen below the app header. The description and files are cut to a
    // few lines ("Read more"); the chat takes the rest, scrolls on its own and keeps its composer
    // at the bottom. The agent notice and stage panel sit above the description, in the same
    // scrollable top area; the details sit in the right column (a sheet below lg).
    return (
      <ViewportFill
        className="mx-auto flex h-[calc(100dvh-3rem)] w-full max-w-6xl flex-col px-4 pt-3 pb-3 sm:px-6"
        data-testid="task-chat-layout"
      >
        <div className="flex shrink-0 items-center gap-1">
          <ItemRailToggle className="-ml-1.5" />
          <BackLink {...backOptions} className="mb-0" />
        </div>
        {header}
        <div className="mt-4 grid min-h-0 flex-1 grid-rows-[minmax(0,1fr)] gap-6 lg:grid-cols-[minmax(0,1fr)_19rem] lg:gap-x-8">
          <div className="flex min-h-0 min-w-0 flex-col gap-4">
            <div className="max-h-[60%] min-h-0 shrink overflow-y-auto">
              <div className="mb-4 grid gap-4 empty:hidden">
                {notice}
                {stagePanel}
              </div>
              <ReadMore disabled={editingDescription}>
                {description}
                {filesSection}
              </ReadMore>
            </div>
            <section aria-label="Conversation" className="flex min-h-56 min-w-0 flex-1 flex-col">
              {conversation}
            </section>
          </div>
          {detailsInSheet ? null : (
            <aside
              aria-label="Task details"
              className="grid min-h-0 min-w-0 grid-cols-1 content-start gap-5 overflow-y-auto pr-1 pb-2"
            >
              {details}
            </aside>
          )}
        </div>
        {detailsInSheet ? (
          <Sheet open={detailsOpen} onOpenChange={setDetailsOpen}>
            <SheetContent side="right" className="w-80 overflow-y-auto p-4 pt-12 sm:max-w-sm">
              <SheetTitle className="sr-only">Task details</SheetTitle>
              <SheetDescription className="sr-only">
                The claim, status, priority, assignees, labels, due date and links.
              </SheetDescription>
              <aside aria-label="Task details" className="grid grid-cols-1 content-start gap-5">
                {details}
              </aside>
            </SheetContent>
          </Sheet>
        ) : null}
        {dialogs}
      </ViewportFill>
    );
  }

  return (
    <PageContainer>
      <div className="flex items-center gap-1">
        <ItemRailToggle className="mb-3 -ml-1.5" />
        <BackLink {...backOptions} />
      </div>
      {/* One column on small screens (header, details, body); two from lg (details on the right). */}
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_19rem] lg:grid-rows-[auto_1fr] lg:gap-x-8 lg:gap-y-0">
        {header}

        <aside
          aria-label="Task details"
          className="grid min-w-0 grid-cols-1 content-start gap-5 self-start border-b pb-6 lg:sticky lg:top-4 lg:col-start-2 lg:row-span-2 lg:row-start-1 lg:border-b-0 lg:pb-0"
        >
          {details}
        </aside>

        <div className="min-w-0 lg:col-start-1 lg:row-start-2">
          {notice}
          {stagePanel ? <div className="lg:mt-6">{stagePanel}</div> : null}
          {description}

          {filesSection}

          <section aria-label="Conversation" className="mt-8">
            {conversation}
          </section>
        </div>
      </div>
      {dialogs}
    </PageContainer>
  );
}

/** "Mia, Leo, Backend" for accessible names. */
function assigneeNames(task: Task): string {
  return [
    ...task.assignees.users.map((user) => user.name),
    ...task.assignees.roles.map((role) => role.name),
  ].join(', ');
}

function Property({
  label,
  hotkey,
  children,
}: {
  label: string;
  hotkey?: string;
  children: ReactNode;
}) {
  return (
    <div className="grid grid-cols-[6.5rem_minmax(0,1fr)] items-start gap-2">
      <dt className="flex h-8 items-center gap-1.5 text-sm text-muted-foreground">
        {label}
        {hotkey ? <Kbd keys={hotkey} className="hidden opacity-70 lg:inline-flex" /> : null}
      </dt>
      <dd className="min-w-0">{children}</dd>
    </div>
  );
}

/**
 * Trigger of a property picker: a quiet full-width button showing the current value. Pickers
 * render it `asChild`, so it passes their props (and ref) through.
 */
function PropertyButton({
  children,
  label,
  ...props
}: ComponentProps<'button'> & { label: string }) {
  return (
    <Button
      variant="ghost"
      size="sm"
      aria-label={label}
      className="h-auto min-h-8 w-full justify-start px-2 py-1 text-left font-normal whitespace-normal disabled:opacity-100"
      {...props}
    >
      {children}
    </Button>
  );
}

function TitleEditor({
  initial,
  pending,
  onSave,
  onCancel,
}: {
  initial: string;
  pending: boolean;
  onSave: (title: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(initial);
  const trimmed = value.trim();
  return (
    <form
      className="flex flex-col gap-2 sm:flex-row sm:items-center"
      onSubmit={(event) => {
        event.preventDefault();
        if (trimmed) onSave(trimmed);
      }}
    >
      <Input
        value={value}
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault();
            onCancel();
          }
        }}
        maxLength={LIMITS.title.max}
        autoFocus
        aria-label="Title"
        className="h-10 text-lg font-semibold"
      />
      <div className="flex shrink-0 gap-2">
        <Button type="submit" size="sm" disabled={!trimmed || pending}>
          {pending ? <Spinner /> : null}
          Save
        </Button>
        <Button type="button" variant="outline" size="sm" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

function DescriptionEditor({
  teamId,
  initial,
  pending,
  onSave,
  onCancel,
}: {
  teamId: string;
  initial: string;
  pending: boolean;
  onSave: (description: string, attachmentIds: string[]) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(initial);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const submit = () =>
    onSave(
      value,
      attachments.map((attachment) => attachment.id),
    );
  return (
    <div className="grid gap-2">
      <RichTextEditor
        value={value}
        onChange={setValue}
        teamId={teamId}
        autoFocus
        onSubmit={submit}
        onAttach={(attachment) => setAttachments((current) => [...current, attachment])}
        label="Description"
      />
      <AttachmentList
        attachments={attachments}
        removeMode="draft"
        canDelete={() => true}
        onDelete={(attachment) =>
          setAttachments((current) => current.filter((item) => item.id !== attachment.id))
        }
      />
      <div className="flex items-center justify-end gap-2">
        <span className="mr-auto hidden items-center gap-1 text-xs text-muted-foreground sm:inline-flex">
          <Kbd keys="mod+enter" /> to save
        </span>
        <Button variant="outline" size="sm" onClick={onCancel} disabled={pending}>
          Cancel
        </Button>
        <Button size="sm" onClick={submit} disabled={pending}>
          {pending ? <Spinner /> : null}
          Save
        </Button>
      </div>
    </div>
  );
}

/** BAT-33: deleting is a visible button in the header, not only an item of the actions menu. */
function DeleteTaskButton({ onDelete }: { onDelete: () => void }) {
  return (
    <Button
      variant="outline"
      size="icon"
      aria-label="Delete task"
      title="Delete task"
      className="mt-4 shrink-0 text-muted-foreground hover:text-destructive"
      onClick={onDelete}
    >
      <Trash2Icon aria-hidden="true" />
    </Button>
  );
}

function TaskMenu({
  task,
  canEditText,
  canDelete,
  onEditTitle,
  onToggleSubscription,
  onDelete,
  url,
}: {
  task: Task;
  canEditText: boolean;
  canDelete: boolean;
  onEditTitle: () => void;
  onToggleSubscription: () => void;
  onDelete: () => void;
  url: string;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="outline"
          size="icon"
          aria-label="Task actions"
          title="More actions"
          className="mt-4 shrink-0"
        >
          <MoreHorizontalIcon aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        {canEditText ? (
          <DropdownMenuItem onSelect={onEditTitle}>
            <PencilIcon aria-hidden="true" />
            Edit title
            <Kbd keys="e" className="ml-auto" />
          </DropdownMenuItem>
        ) : null}
        <DropdownMenuItem onSelect={() => void copyText(task.ref, task.ref)}>
          <CopyIcon aria-hidden="true" />
          Copy {task.ref}
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => void copyText(url)}>
          <LinkIcon aria-hidden="true" />
          Copy link
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={onToggleSubscription}>
          {task.subscribed ? <BellOffIcon aria-hidden="true" /> : <BellIcon aria-hidden="true" />}
          {task.subscribed ? 'Unsubscribe' : 'Subscribe'}
        </DropdownMenuItem>
        {canEditText ? (
          <ConversationModeMenuItem
            parentType="task"
            parentId={task.id}
            projectId={task.projectId}
            mode={task.conversationMode}
          />
        ) : null}
        {canDelete ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" onSelect={onDelete}>
              <Trash2Icon aria-hidden="true" />
              Delete task
            </DropdownMenuItem>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * The task's back link: the project's board or list (as the viewer last left it), or My tasks
 * when the task was opened from there.
 */
function useTaskBackOptions(team: MeTeam, project: MeProject): BackOptions {
  const [view] = useTaskView(project.id);
  return {
    to: tasksViewPath(`/t/${team.slug}/p/${project.key}`, project.id),
    label: view === 'list' ? 'List' : 'Board',
    also: [{ pathname: '/my-tasks', label: 'My tasks' }],
  };
}

function TaskSkeleton({ team, project }: { team: MeTeam; project: MeProject }) {
  return (
    <PageContainer>
      <BackLink {...useTaskBackOptions(team, project)} />
      <div
        className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_19rem]"
        role="status"
        aria-label="Loading task"
      >
        <div className="grid content-start gap-3">
          <Skeleton className="h-4 w-16" />
          <Skeleton className="h-8 w-3/4" />
          <Skeleton className="h-4 w-56" />
          <Skeleton className="mt-6 h-32 w-full" />
          <Skeleton className="mt-6 h-20 w-full" />
        </div>
        <div className="grid content-start gap-3">
          <Skeleton className="h-24 w-full" />
          {Array.from({ length: 5 }, (_, index) => (
            <Skeleton key={index} className="h-8 w-full" />
          ))}
        </div>
      </div>
    </PageContainer>
  );
}

/**
 * Where the task sits: Team › Project › Pipeline › Stage › ref, each step up linking to its page
 * (the pipeline's board; the stage, that board filtered to it).
 */
function TaskLocation({ task, team, project }: { task: Task; team: MeTeam; project: MeProject }) {
  const projectBase = `/t/${team.slug}/p/${project.key}`;
  const pipeline = task.status.pipeline;
  const board = pipeline ? pipelineBoardPath(projectBase, pipeline.id) : `${projectBase}/tasks`;
  const steps = [
    { label: team.name, to: `/t/${team.slug}` },
    { label: project.name, to: projectBase },
    ...(pipeline ? [{ label: pipeline.name, to: board }] : []),
    {
      label: task.status.name,
      to: `${board}${board.includes('?') ? '&' : '?'}status=${encodeURIComponent(task.status.id)}`,
    },
  ];
  return (
    <nav aria-label="Task location" className="mb-1 min-w-0 text-xs text-muted-foreground">
      <ol className="flex flex-wrap items-center gap-x-1 gap-y-0.5">
        {steps.map((step) => (
          <li key={step.to} className="flex min-w-0 items-center gap-1">
            <Link
              to={step.to}
              className="max-w-40 truncate rounded-sm outline-none hover:text-foreground hover:underline focus-visible:ring-2 focus-visible:ring-ring"
            >
              {step.label}
            </Link>
            <ChevronRightIcon className="size-3 shrink-0" aria-hidden="true" />
          </li>
        ))}
        <li aria-current="page" className="font-mono tabular-nums">
          {task.ref}
        </li>
      </ol>
    </nav>
  );
}
