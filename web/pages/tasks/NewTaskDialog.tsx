import { SquarePenIcon } from 'lucide-react';
import { lazy, Suspense, useState } from 'react';
import { matchPath, useLocation } from 'react-router';
import type { MeProject, MeTeam } from '@shared/schemas/core';
import { usePaletteCommands } from '@web/components/palette/registry';
import { Skeleton } from '@web/components/ui/skeleton';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@web/components/ui/dialog';
import { useMe } from '@web/lib/auth';
import { useHotkey } from '@web/lib/hotkeys';
import { findProject, findTeam } from '@web/lib/routeContext';
import { useShellActionHandler } from '@web/lib/shellActions';
import type { TaskPrefill } from '@web/lib/taskPrefill';
import type { ProjectChoice } from './NewTaskForm';

/**
 * The form, with the rich text editor and the date picker, is its own chunk: this shell extension
 * is mounted on every signed-in page, and only the dialog needs them.
 */
const NewTaskForm = lazy(() => import('./NewTaskForm'));

declare module '@web/lib/shellActions' {
  interface ShellActionPayloads {
    /**
     * Open the "New task" dialog, in a project (and a status column) or with a project picker;
     * `prefill` starts it from an issue or messages (Create task, Make task from this).
     */
    'task.create': {
      projectId?: string;
      statusId?: string;
      pipelineId?: string;
      prefill?: TaskPrefill;
    };
  }
}

/**
 * The "New task" dialog (shell extension): `c` inside a project, the palette's "New task…", the
 * board's New task button and a column's quick-add `+` (preset to that status). Outside a project
 * it asks for one among those where the viewer may create tasks.
 */

/** Project permissions (design §3); a project without them falls back to the team's. */
function canCreateIn(team: MeTeam, project: MeProject): boolean {
  return (project.permissions ?? team.permissions).includes('CREATE_TASKS');
}

export default function NewTaskDialog() {
  const me = useMe().data;
  const { pathname, search } = useLocation();
  const [open, setOpen] = useState(false);
  const [preset, setPreset] = useState<{
    projectId?: string;
    statusId?: string;
    pipelineId?: string;
    prefill?: TaskPrefill;
  }>({});

  const choices: ProjectChoice[] = (me?.teams ?? []).flatMap((team) =>
    team.projects
      .filter((project) => canCreateIn(team, project))
      .map((project) => ({ team, project })),
  );
  const match = matchPath({ path: '/t/:team/p/:key', end: false }, pathname);
  const routeTeam = me && match ? findTeam(me.teams, match.params.team) : null;
  const routeProject = findProject(routeTeam, match?.params.key);
  const routeChoice = choices.find((choice) => choice.project.id === routeProject?.id);

  const show = (
    next: {
      projectId?: string;
      statusId?: string;
      pipelineId?: string;
      prefill?: TaskPrefill;
    } = {},
  ) => {
    setPreset({
      prefill: next.prefill,
      projectId: next.projectId ?? routeChoice?.project.id,
      statusId: next.statusId,
      // The board's pipeline (BAT-25), when `c` is pressed on it.
      pipelineId:
        next.pipelineId ??
        (next.projectId ? undefined : (new URLSearchParams(search).get('pipeline') ?? undefined)),
    });
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
          <Suspense fallback={<NewTaskFormSkeleton />}>
            <NewTaskForm
              choices={choices}
              initialProjectId={preset.projectId}
              initialStatusId={preset.statusId}
              initialPipelineId={preset.pipelineId}
              prefill={preset.prefill}
              onDone={() => setOpen(false)}
            />
          </Suspense>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

/** Shown while the form's chunk loads (the dialog keeps its title for screen readers). */
function NewTaskFormSkeleton() {
  return (
    <div className="grid gap-4" aria-busy="true">
      <DialogHeader>
        <DialogTitle>New task</DialogTitle>
        <DialogDescription>Loading…</DialogDescription>
      </DialogHeader>
      <Skeleton className="h-10 w-full" />
      <Skeleton className="h-28 w-full" />
      <div className="flex gap-2">
        <Skeleton className="h-8 w-24" />
        <Skeleton className="h-8 w-24" />
        <Skeleton className="h-8 w-24" />
      </div>
    </div>
  );
}
