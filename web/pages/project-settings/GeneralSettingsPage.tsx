import { AlertTriangleIcon, Trash2Icon } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router';
import { toast } from 'sonner';
import { LIMITS } from '@shared/constants';
import type { MeTeam } from '@shared/schemas/core';
import {
  updateProjectInputSchema,
  type Project,
  type UpdateProjectInput,
} from '@shared/schemas/projects';
import { FormField } from '@web/components/auth/FormField';
import { ConfirmDialog } from '@web/components/common/ConfirmDialog';
import { EntityIcon } from '@web/components/common/EntityIcon';
import { ErrorState } from '@web/components/common/ErrorState';
import { Spinner } from '@web/components/common/Spinner';
import { ColorPicker } from '@web/components/pickers/ColorPicker';
import { EmojiPicker } from '@web/components/pickers/EmojiPicker';
import { Button } from '@web/components/ui/button';
import { Input } from '@web/components/ui/input';
import { Skeleton } from '@web/components/ui/skeleton';
import { Textarea } from '@web/components/ui/textarea';
import { isApiError } from '@web/lib/api';
import { fieldErrors } from '@web/lib/forms';
import { useTeamAccess } from '@web/lib/permissions';
import { useRouteContext } from '@web/lib/routeContext';
import { useDocumentTitle } from '@web/lib/title';
import { useKeyAvailability } from '../projects/keyAvailability';
import { KeyStatus, ProjectKeyInput } from '../projects/ProjectKeyField';
import {
  useDeleteProject,
  useProject,
  useRestoreProject,
  useUpdateProject,
} from '../projects/queries';
import { UnsavedChangesGuard } from '../projects/UnsavedChangesGuard';
import { ReadOnlyNotice, SettingsCard, SettingsHeader } from './common';

/** Project settings → General: name, key, description, icon, color, and deleting the project. */
export default function GeneralSettingsPage() {
  const { team, project } = useRouteContext();
  const details = useProject(project?.id);
  useDocumentTitle(['Settings', project?.name]);
  if (!team || !project) return null;

  if (details.isError) {
    return (
      <ErrorState
        title="Couldn’t load the project"
        error={details.error}
        onRetry={() => void details.refetch()}
      />
    );
  }
  if (!details.data) return <GeneralSkeleton />;
  return <GeneralSettings team={team} project={details.data} />;
}

type Field = 'name' | 'key' | 'description';

interface Values {
  name: string;
  key: string;
  description: string;
  icon: string | null;
  color: string;
}

function valuesOf(project: Project): Values {
  return {
    name: project.name,
    key: project.key,
    description: project.description,
    icon: project.icon,
    color: project.color,
  };
}

function GeneralSettings({ team, project }: { team: MeTeam; project: Project }) {
  const navigate = useNavigate();
  const access = useTeamAccess(team.id);
  const canEdit = access.has('MANAGE_PROJECTS');
  const update = useUpdateProject(project.id);
  const [baseline, setBaseline] = useState(project);
  const [values, setValues] = useState<Values>(() => valuesOf(project));
  const [errors, setErrors] = useState<Partial<Record<Field, string>>>({});

  const saved = valuesOf(baseline);
  const changed = (Object.keys(values) as Array<keyof Values>).filter(
    (field) => values[field] !== saved[field],
  );
  const dirty = changed.length > 0;

  // Someone else saved the project: take their values unless this form has edits.
  if (project.updatedAt !== baseline.updatedAt && !update.isPending) {
    setBaseline(project);
    if (!dirty) setValues(valuesOf(project));
  }

  const availability = useKeyAvailability(team.id, values.key, {
    projectId: project.id,
    currentKey: baseline.key,
  });

  const set = <K extends keyof Values>(field: K, value: Values[K]) =>
    setValues((current) => ({ ...current, [field]: value }));

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!dirty || update.isPending) return;
    const input: UpdateProjectInput = {};
    if (changed.includes('name')) input.name = values.name;
    if (changed.includes('key')) input.key = values.key;
    if (changed.includes('description')) input.description = values.description;
    if (changed.includes('icon')) input.icon = values.icon;
    if (changed.includes('color')) input.color = values.color;
    const parsed = updateProjectInputSchema.safeParse(input);
    const nextErrors: Partial<Record<Field, string>> = parsed.success
      ? {}
      : fieldErrors<Field>(parsed.error);
    if (availability.state === 'taken') nextErrors.key = availability.message;
    setErrors(nextErrors);
    if (!parsed.success || Object.keys(nextErrors).length > 0) return;

    update.mutate(parsed.data, {
      onSuccess: (next) => {
        setBaseline(next);
        setValues(valuesOf(next));
        toast.success('Project saved');
        if (next.key !== project.key) {
          void navigate(`/t/${team.slug}/p/${next.key}/settings/general`, { replace: true });
        }
      },
      onError: (error) => {
        if (isApiError(error) && error.code === 'conflict') setErrors({ key: error.message });
        else if (isApiError(error) && error.code === 'validation_failed') {
          setErrors(error.fieldErrors);
        }
      },
    });
  };

  return (
    <div>
      <SettingsHeader
        title="General"
        description="How the project appears across Baton, and the key used in task and issue refs."
      />
      {canEdit ? null : <ReadOnlyNotice permission="Manage projects" />}

      <form onSubmit={submit} noValidate>
        <SettingsCard>
          <fieldset disabled={!canEdit || update.isPending} className="grid gap-5 p-4 sm:p-6">
            <legend className="sr-only">Project details</legend>
            <div className="flex items-end gap-3">
              <div className="flex shrink-0 gap-1.5 pb-px">
                <EmojiPicker
                  value={values.icon}
                  onChange={(icon) => set('icon', icon)}
                  label="Project icon"
                  disabled={!canEdit}
                >
                  <Button
                    type="button"
                    variant="outline"
                    size="icon"
                    aria-label={
                      values.icon ? `Project icon: ${values.icon}` : 'Choose a project icon'
                    }
                  >
                    <EntityIcon
                      icon={values.icon}
                      name={values.name || project.name}
                      color={values.color}
                      className="size-6 rounded-md text-base"
                    />
                  </Button>
                </EmojiPicker>
                <ColorPicker
                  value={values.color}
                  onChange={(color) => set('color', color)}
                  label="Project color"
                  disabled={!canEdit}
                />
              </div>
              <FormField label="Name" error={errors.name} className="min-w-0 flex-1">
                {(field) => (
                  <Input
                    {...field}
                    value={values.name}
                    onChange={(event) => set('name', event.target.value)}
                    maxLength={LIMITS.projectName.max}
                    autoComplete="off"
                  />
                )}
              </FormField>
            </div>

            <FormField
              label="Key"
              error={errors.key}
              hint={
                <KeyStatus
                  keyValue={values.key}
                  availability={availability}
                  onUseSuggestion={(suggestion) => set('key', suggestion)}
                />
              }
            >
              {(field) => (
                <div className="grid gap-2">
                  <ProjectKeyInput
                    id={field.id}
                    value={values.key}
                    invalid={Boolean(field['aria-invalid'])}
                    describedBy={field['aria-describedby']}
                    onChange={(key) => set('key', key)}
                    disabled={!canEdit}
                  />
                  {values.key !== baseline.key ? (
                    <p className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-800 dark:text-amber-200">
                      <AlertTriangleIcon className="mt-px size-3.5 shrink-0" aria-hidden="true" />
                      <span>
                        Task and issue refs become {values.key || 'KEY'}-12 and{' '}
                        {values.key || 'KEY'}#51, and the project’s URLs change. Old refs and links
                        with {baseline.key} keep working.
                      </span>
                    </p>
                  ) : null}
                </div>
              )}
            </FormField>

            <FormField
              label="Description"
              error={errors.description}
              hint={`${values.description.length}/${LIMITS.projectDescription.max} · Shown on project cards and in the project header`}
            >
              {(field) => (
                <Textarea
                  {...field}
                  value={values.description}
                  onChange={(event) => set('description', event.target.value)}
                  maxLength={LIMITS.projectDescription.max}
                  rows={3}
                  placeholder="What is this project about?"
                  className="max-h-40 resize-none"
                />
              )}
            </FormField>
          </fieldset>
          {canEdit ? (
            <div className="flex items-center justify-end gap-2 border-t px-4 py-3 sm:px-6">
              {dirty ? (
                <span className="mr-auto text-xs text-muted-foreground">Unsaved changes</span>
              ) : null}
              <Button
                type="button"
                variant="ghost"
                disabled={!dirty || update.isPending}
                onClick={() => {
                  setValues(valuesOf(baseline));
                  setErrors({});
                }}
              >
                Reset
              </Button>
              <Button type="submit" disabled={!dirty || update.isPending}>
                {update.isPending ? <Spinner /> : null}
                Save changes
              </Button>
            </div>
          ) : null}
        </SettingsCard>
      </form>

      {canEdit ? <DangerZone team={team} project={baseline} /> : null}
      <UnsavedChangesGuard when={dirty && !update.isPending} what="project settings" />
    </div>
  );
}

function DangerZone({ team, project }: { team: MeTeam; project: Project }) {
  const navigate = useNavigate();
  const remove = useDeleteProject();
  const restore = useRestoreProject();
  const [confirming, setConfirming] = useState(false);
  const { openTasks, doneTasks, openIssues, resolvedIssues } = project.counts;
  const tasks = openTasks + doneTasks;
  const issues = openIssues + resolvedIssues;

  return (
    <section aria-labelledby="danger-zone" className="mt-8">
      <h3 id="danger-zone" className="mb-2 text-sm font-semibold text-destructive">
        Danger zone
      </h3>
      <SettingsCard className="flex flex-wrap items-center justify-between gap-4 border-destructive/40 p-4 sm:p-6">
        <div className="min-w-0 flex-1 basis-64 space-y-1">
          <p className="text-sm font-medium">Delete this project</p>
          <p className="text-sm text-muted-foreground">
            Moves {project.name} and its {tasks} {tasks === 1 ? 'task' : 'tasks'} and {issues}{' '}
            {issues === 1 ? 'issue' : 'issues'} to Trash. They can be restored for 30 days.
          </p>
        </div>
        <Button variant="destructive" onClick={() => setConfirming(true)}>
          <Trash2Icon aria-hidden="true" />
          Delete project
        </Button>
      </SettingsCard>
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title={`Delete ${project.name}?`}
        description={
          <>
            The project, its board and its issues disappear for everyone in {team.name}. Anyone with
            “Manage projects” or “Manage trash” can restore it from Trash within 30 days.
          </>
        }
        confirmLabel="Delete project"
        destructive
        typedConfirmation={project.key}
        onConfirm={async () => {
          await remove.mutateAsync(project);
          void navigate(`/t/${team.slug}`);
          toast.success(`Moved ${project.name} to Trash`, {
            action: {
              label: 'Undo',
              onClick: () =>
                // This page has unmounted by now: use the promise, not per-call callbacks
                // (which only run while the component is mounted). Errors toast globally.
                void restore
                  .mutateAsync(project.id)
                  .then((restored) => {
                    toast.success(`Restored ${restored.name}`);
                    void navigate(restored.path);
                  })
                  .catch(() => undefined),
            },
          });
        }}
      />
    </section>
  );
}

function GeneralSkeleton() {
  return (
    <div role="status" aria-label="Loading settings">
      <Skeleton className="mb-2 h-6 w-32" />
      <Skeleton className="mb-6 h-4 w-80 max-w-full" />
      <div className="grid gap-5 rounded-lg border p-6">
        {[0, 1, 2].map((index) => (
          <div key={index} className="grid gap-2">
            <Skeleton className="h-4 w-20" />
            <Skeleton className="h-9 w-full" />
          </div>
        ))}
      </div>
    </div>
  );
}
