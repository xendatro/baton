import { SquarePenIcon } from 'lucide-react';
import { useRef, useState, type FormEvent } from 'react';
import { matchPath, useLocation, useNavigate } from 'react-router';
import { toast } from 'sonner';
import { LIMITS, type PriorityValue } from '@shared/constants';
import type { Attachment, MeProject, MeTeam } from '@shared/schemas/core';
import { createTaskInputSchema } from '@shared/schemas/tasks';
import { AttachmentList } from '@web/components/attachments/AttachmentList';
import { FormError } from '@web/components/auth/FormField';
import { EntityIcon } from '@web/components/common/EntityIcon';
import { Kbd } from '@web/components/common/Kbd';
import { Spinner } from '@web/components/common/Spinner';
import { RichTextEditor, type RichTextEditorHandle } from '@web/components/editor/RichTextEditor';
import { usePaletteCommands } from '@web/components/palette/registry';
import { AssigneePicker, type AssigneeValue } from '@web/components/pickers/AssigneePicker';
import { DatePicker } from '@web/components/pickers/DatePicker';
import { LabelPicker } from '@web/components/pickers/LabelPicker';
import { PriorityPicker } from '@web/components/pickers/PriorityPicker';
import { StatusPicker } from '@web/components/pickers/StatusPicker';
import { Button } from '@web/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@web/components/ui/dialog';
import { Input } from '@web/components/ui/input';
import { Label } from '@web/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@web/components/ui/select';
import { Switch } from '@web/components/ui/switch';
import { errorMessage, isApiError } from '@web/lib/api';
import { useMe } from '@web/lib/auth';
import { useHotkey } from '@web/lib/hotkeys';
import { findProject, findTeam } from '@web/lib/routeContext';
import { useShellActionHandler } from '@web/lib/shellActions';
import { useCreateLabel, useLabels, useStatuses } from '../projects/queries';
import { useAssignables, useCreateTask } from './queries';

declare module '@web/lib/shellActions' {
  interface ShellActionPayloads {
    /** Open the "New task" dialog, in a project (and a status column) or with a project picker. */
    'task.create': { projectId?: string; statusId?: string };
  }
}

/**
 * The "New task" dialog (shell extension): `c` inside a project, the palette's "New task…", the
 * board's New task button and a column's quick-add `+` (preset to that status). Outside a project
 * it asks for one among those where the viewer may create tasks.
 */

interface ProjectChoice {
  team: MeTeam;
  project: MeProject;
}

function canCreateIn(team: MeTeam): boolean {
  return team.permissions.includes('CREATE_TASKS');
}

export default function NewTaskDialog() {
  const me = useMe().data;
  const { pathname } = useLocation();
  const [open, setOpen] = useState(false);
  const [preset, setPreset] = useState<{ projectId?: string; statusId?: string }>({});

  const choices: ProjectChoice[] = (me?.teams ?? [])
    .filter(canCreateIn)
    .flatMap((team) => team.projects.map((project) => ({ team, project })));
  const match = matchPath({ path: '/t/:team/p/:key', end: false }, pathname);
  const routeTeam = me && match ? findTeam(me.teams, match.params.team) : null;
  const routeProject = findProject(routeTeam, match?.params.key);
  const routeChoice = choices.find((choice) => choice.project.id === routeProject?.id);

  const show = (next: { projectId?: string; statusId?: string } = {}) => {
    setPreset({ projectId: next.projectId ?? routeChoice?.project.id, statusId: next.statusId });
    setOpen(true);
  };
  useShellActionHandler('task.create', (payload) => show(payload));
  useHotkey('c', () => show(), {
    description: 'New task',
    group: 'Project',
    enabled: Boolean(routeChoice) && !open,
  });
  usePaletteCommands(
    choices.length > 0
      ? [
          {
            id: 'task.create',
            label: routeChoice ? `New task in ${routeChoice.project.name}…` : 'New task…',
            group: 'Projects',
            icon: SquarePenIcon,
            keywords: ['create task', 'add task', 'new issue card'],
            ...(routeChoice ? { shortcut: 'c' } : {}),
            perform: () => show(),
          },
        ]
      : [],
  );

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-2xl">
        {open ? (
          <NewTaskForm
            choices={choices}
            initialProjectId={preset.projectId}
            initialStatusId={preset.statusId}
            onDone={() => setOpen(false)}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

interface NewTaskFormProps {
  choices: ProjectChoice[];
  initialProjectId: string | undefined;
  initialStatusId: string | undefined;
  onDone: () => void;
}

function NewTaskForm({ choices, initialProjectId, initialStatusId, onDone }: NewTaskFormProps) {
  const requested = choices.find((choice) => choice.project.id === initialProjectId);
  const [projectId, setProjectId] = useState<string | null>(
    requested?.project.id ?? (choices.length === 1 ? (choices[0]?.project.id ?? null) : null),
  );
  const choice = choices.find((candidate) => candidate.project.id === projectId) ?? null;

  if (choices.length === 0) {
    return (
      <>
        <DialogHeader>
          <DialogTitle>New task</DialogTitle>
          <DialogDescription>
            You don’t have permission to create tasks in any project. Ask a team admin for the
            “Create tasks” permission.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={onDone}>
            Close
          </Button>
        </DialogFooter>
      </>
    );
  }

  return (
    <div className="grid gap-4">
      <DialogHeader>
        <DialogTitle>New task</DialogTitle>
        <DialogDescription>
          {choice ? `In ${choice.project.name} (${choice.project.key}).` : 'Choose a project.'}
        </DialogDescription>
      </DialogHeader>
      {requested ? null : (
        <div className="grid gap-1.5">
          <Label htmlFor="new-task-project">Project</Label>
          <Select value={projectId ?? ''} onValueChange={setProjectId}>
            <SelectTrigger id="new-task-project" className="w-full">
              <SelectValue placeholder="Choose a project" />
            </SelectTrigger>
            <SelectContent>
              {choices.map(({ team, project }) => (
                <SelectItem key={project.id} value={project.id}>
                  <EntityIcon icon={project.icon} name={project.name} color={project.color} />
                  {project.name}
                  <span className="text-muted-foreground">· {team.name}</span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}
      {choice ? (
        <TaskFields
          key={choice.project.id}
          team={choice.team}
          project={choice.project}
          initialStatusId={choice.project.id === initialProjectId ? initialStatusId : undefined}
          onDone={onDone}
        />
      ) : (
        <DialogFooter>
          <Button variant="outline" onClick={onDone}>
            Cancel
          </Button>
          <Button disabled>Create task</Button>
        </DialogFooter>
      )}
    </div>
  );
}

function TaskFields({
  team,
  project,
  initialStatusId,
  onDone,
}: {
  team: MeTeam;
  project: MeProject;
  initialStatusId: string | undefined;
  onDone: () => void;
}) {
  const navigate = useNavigate();
  const me = useMe().data;
  const statuses = useStatuses(project.id);
  const labels = useLabels(project.id);
  const createLabel = useCreateLabel(project.id);
  const people = useAssignables(team.id);
  const create = useCreateTask(project.id);
  const editor = useRef<RichTextEditorHandle>(null);
  const titleRef = useRef<HTMLInputElement>(null);

  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [statusId, setStatusId] = useState<string | null>(initialStatusId ?? null);
  const [priority, setPriority] = useState<PriorityValue>(0);
  const [assignees, setAssignees] = useState<AssigneeValue>({ userIds: [], roleIds: [] });
  const [labelIds, setLabelIds] = useState<string[]>([]);
  const [dueDate, setDueDate] = useState<string | null>(null);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [createMore, setCreateMore] = useState(false);
  const [titleError, setTitleError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);

  const statusList = statuses.data ?? [];
  const effectiveStatus =
    statusId ?? statusList.find((status) => status.isDefault)?.id ?? statusList[0]?.id ?? null;
  const canManageLabels = team.permissions.includes('MANAGE_LABELS');

  const submit = (event?: FormEvent) => {
    event?.preventDefault();
    if (create.isPending) return;
    setFormError(null);
    const parsed = createTaskInputSchema.safeParse({
      title,
      description: description.trim() ? description : undefined,
      statusId: effectiveStatus ?? undefined,
      priority,
      dueDate,
      assigneeUserIds: assignees.userIds,
      assigneeRoleIds: assignees.roleIds,
      labelIds,
      attachmentIds: attachments.map((attachment) => attachment.id),
    });
    if (!parsed.success) {
      setTitleError(
        parsed.error.issues.find((issue) => issue.path[0] === 'title')?.message ?? null,
      );
      if (!parsed.error.issues.some((issue) => issue.path[0] === 'title')) {
        setFormError(parsed.error.issues[0]?.message ?? 'Check the fields');
      }
      titleRef.current?.focus();
      return;
    }
    setTitleError(null);
    create.mutate(parsed.data, {
      onSuccess: (task) => {
        toast.success(`Created ${task.ref}`, {
          description: task.title,
          action: { label: 'Open', onClick: () => void navigate(task.path) },
        });
        if (createMore) {
          setTitle('');
          setDescription('');
          setAttachments([]);
          editor.current?.clear();
          titleRef.current?.focus();
        } else {
          onDone();
        }
      },
      onError: (error) => {
        if (isApiError(error) && error.code === 'validation_failed' && error.fieldErrors.title) {
          setTitleError(error.fieldErrors.title);
        } else {
          setFormError(errorMessage(error));
        }
      },
    });
  };

  return (
    <form
      onSubmit={submit}
      className="grid gap-4"
      noValidate
      onKeyDown={(event) => {
        // The description editor submits on its own (and marks the event handled).
        if (event.defaultPrevented) return;
        if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
          event.preventDefault();
          submit();
        }
      }}
    >
      <div className="grid gap-1.5">
        <Label htmlFor="new-task-title" className="sr-only">
          Title
        </Label>
        <Input
          id="new-task-title"
          ref={titleRef}
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          placeholder="Task title"
          maxLength={LIMITS.title.max}
          autoFocus
          autoComplete="off"
          aria-invalid={titleError ? true : undefined}
          aria-describedby={titleError ? 'new-task-title-error' : undefined}
          className="h-10 text-base font-medium"
        />
        {titleError ? (
          <p id="new-task-title-error" role="alert" className="text-xs text-destructive">
            {titleError}
          </p>
        ) : null}
      </div>
      <RichTextEditor
        ref={editor}
        value={description}
        onChange={setDescription}
        variant="compact"
        placeholder="Add a description… Type / for blocks, @ to mention."
        teamId={team.id}
        onAttach={(attachment) => setAttachments((current) => [...current, attachment])}
        onSubmit={() => submit()}
        label="Description"
        className="max-h-72 min-h-28 overflow-y-auto"
      />
      <AttachmentList
        attachments={attachments}
        removeMode="draft"
        canDelete={() => true}
        onDelete={(attachment) =>
          setAttachments((current) => current.filter((item) => item.id !== attachment.id))
        }
      />
      <div className="flex flex-wrap items-center gap-2">
        <StatusPicker statuses={statusList} value={effectiveStatus} onChange={setStatusId} />
        <PriorityPicker value={priority} onChange={setPriority} />
        <AssigneePicker
          users={people.users}
          roles={people.roles}
          value={assignees}
          onChange={setAssignees}
          currentUserId={me?.user.id}
        />
        <LabelPicker
          labels={labels.data ?? []}
          value={labelIds}
          onChange={setLabelIds}
          onCreate={canManageLabels ? (name) => createLabel.mutateAsync({ name }) : undefined}
        />
        <DatePicker value={dueDate} onChange={setDueDate} />
      </div>
      <FormError message={formError} />
      <div className="flex flex-wrap items-center justify-between gap-3">
        <label className="flex items-center gap-2 text-sm text-muted-foreground">
          <Switch checked={createMore} onCheckedChange={setCreateMore} />
          Create more
        </label>
        <div className="ml-auto flex items-center gap-2">
          <span className="hidden items-center gap-1 text-xs text-muted-foreground sm:inline-flex">
            <Kbd keys="mod+enter" />
          </span>
          <Button type="button" variant="outline" onClick={onDone} disabled={create.isPending}>
            Cancel
          </Button>
          <Button type="submit" disabled={create.isPending || !title.trim()}>
            {create.isPending ? <Spinner /> : null}
            Create task
          </Button>
        </div>
      </div>
    </form>
  );
}
