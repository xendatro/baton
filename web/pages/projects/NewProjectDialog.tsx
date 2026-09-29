import { FolderPlusIcon } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router';
import { toast } from 'sonner';
import { DEFAULT_PROJECT_COLOR, LIMITS } from '@shared/constants';
import {
  DEFAULT_PIPELINE_TEMPLATE,
  PIPELINE_TEMPLATE_LIST,
  PIPELINE_TEMPLATES,
  type PipelineTemplateId,
} from '@shared/pipelineTemplates';
import type { MeTeam } from '@shared/schemas/core';
import {
  createProjectInputSchema,
  deriveProjectKey,
  type CreateProjectInput,
} from '@shared/schemas/projects';
import { FormError, FormField } from '@web/components/auth/FormField';
import { EntityIcon } from '@web/components/common/EntityIcon';
import { Spinner } from '@web/components/common/Spinner';
import { usePaletteCommands } from '@web/components/palette/registry';
import { ColorPicker } from '@web/components/pickers/ColorPicker';
import { EmojiPicker } from '@web/components/pickers/EmojiPicker';
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@web/components/ui/select';
import { Textarea } from '@web/components/ui/textarea';
import { errorMessage, isApiError } from '@web/lib/api';
import { useMe } from '@web/lib/auth';
import { fieldErrors } from '@web/lib/forms';
import { useRouteContext } from '@web/lib/routeContext';
import { useShellActionHandler } from '@web/lib/shellActions';
import { useKeyAvailability } from './keyAvailability';
import { KeyStatus, ProjectKeyInput } from './ProjectKeyField';
import { useCreateProject } from './queries';

/**
 * The "New project" dialog (shell extension). Opened by the `project.create` shell action, with
 * `{ teamId }` from a team page, or without one (then it asks for the team), and by the palette's
 * "New project" command. Only teams where the viewer has `MANAGE_PROJECTS` are offered.
 */

function canCreateIn(team: MeTeam): boolean {
  return team.permissions.includes('MANAGE_PROJECTS');
}

export default function NewProjectDialog() {
  const me = useMe().data;
  const { team: routeTeam } = useRouteContext();
  const [open, setOpen] = useState(false);
  const [requestedTeamId, setRequestedTeamId] = useState<string | undefined>();
  const eligible = (me?.teams ?? []).filter(canCreateIn);

  const show = (teamId?: string) => {
    setRequestedTeamId(teamId);
    setOpen(true);
  };
  useShellActionHandler('project.create', (payload) => show(payload.teamId));
  usePaletteCommands(
    eligible.length > 0
      ? [
          {
            id: 'project.create',
            label: 'New project…',
            group: 'Projects',
            icon: FolderPlusIcon,
            keywords: ['create project', 'add project'],
            perform: () => show(routeTeam && canCreateIn(routeTeam) ? routeTeam.id : undefined),
          },
        ]
      : [],
  );

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="sm:max-w-lg">
        {open ? (
          <NewProjectForm
            teams={eligible}
            initialTeamId={requestedTeamId}
            onDone={() => setOpen(false)}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

type Field = 'teamId' | 'name' | 'key' | 'description' | 'pipelineName';

function NewProjectForm({
  teams,
  initialTeamId,
  onDone,
}: {
  teams: MeTeam[];
  initialTeamId: string | undefined;
  onDone: () => void;
}) {
  const navigate = useNavigate();
  const create = useCreateProject();
  const requested = teams.find((team) => team.id === initialTeamId);
  const [teamId, setTeamId] = useState<string | null>(
    requested?.id ?? (teams.length === 1 ? (teams[0]?.id ?? null) : null),
  );
  const [name, setName] = useState('');
  const [key, setKey] = useState('');
  const [keyEdited, setKeyEdited] = useState(false);
  const [description, setDescription] = useState('');
  // Pipelines are mandatory: a project starts with one, named here.
  const [pipelineName, setPipelineName] = useState('');
  const [template, setTemplate] = useState<PipelineTemplateId>(DEFAULT_PIPELINE_TEMPLATE);
  const [icon, setIcon] = useState<string | null>(null);
  const [color, setColor] = useState<string>(DEFAULT_PROJECT_COLOR);
  const [errors, setErrors] = useState<Partial<Record<Field, string>>>({});
  const [formError, setFormError] = useState<string | null>(null);

  const effectiveKey = keyEdited ? key : name.trim() ? deriveProjectKey(name) : '';
  const availability = useKeyAvailability(teamId, effectiveKey);
  // A derived key that is taken quietly becomes the suggested free one.
  const derivedTaken = !keyEdited && availability.state === 'taken';
  const finalKey = derivedTaken ? availability.suggestion : effectiveKey;
  const shownAvailability =
    derivedTaken && availability.state === 'taken'
      ? ({ state: 'available' } as const)
      : availability;

  if (teams.length === 0) {
    return (
      <>
        <DialogHeader>
          <DialogTitle>New project</DialogTitle>
          <DialogDescription>
            You don’t have permission to create projects in any of your teams. Ask a team admin for
            the “Manage projects” permission.
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

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (create.isPending) return;
    setFormError(null);
    const nextErrors: Partial<Record<Field, string>> = {};
    if (!teamId) nextErrors.teamId = 'Choose a team';
    const input: CreateProjectInput = {
      name,
      key: finalKey || undefined,
      description,
      icon,
      color,
      pipelineName,
      ...(template !== DEFAULT_PIPELINE_TEMPLATE ? { pipelineTemplate: template } : {}),
    };
    const parsed = createProjectInputSchema.safeParse(input);
    if (!parsed.success) Object.assign(nextErrors, fieldErrors<Field>(parsed.error));
    if (!pipelineName.trim()) nextErrors.pipelineName = 'Name the project’s first pipeline';
    if (availability.state === 'taken' && keyEdited) nextErrors.key = availability.message;
    setErrors(nextErrors);
    if (!teamId || !parsed.success || Object.keys(nextErrors).length > 0) return;

    create.mutate(
      { teamId, input: parsed.data },
      {
        onSuccess: (project) => {
          toast.success(`Created ${project.name}`);
          onDone();
          void navigate(project.path);
        },
        onError: (error) => {
          if (isApiError(error) && error.code === 'conflict') {
            setErrors({ key: error.message });
          } else if (isApiError(error) && error.code === 'validation_failed') {
            setErrors(error.fieldErrors);
            setFormError(error.message);
          } else {
            setFormError(errorMessage(error));
          }
        },
      },
    );
  };

  return (
    <form onSubmit={submit} className="grid gap-5" noValidate>
      <DialogHeader>
        <DialogTitle>New project</DialogTitle>
        <DialogDescription>
          {requested ? `In ${requested.name}. ` : ''}Projects hold pipelines of tasks and a forum of
          issues. You can change everything later.
        </DialogDescription>
      </DialogHeader>

      {requested ? null : (
        <FormField label="Team" error={errors.teamId}>
          {(field) => (
            <Select value={teamId ?? ''} onValueChange={(value) => setTeamId(value)}>
              <SelectTrigger {...field} className="w-full">
                <SelectValue placeholder="Choose a team" />
              </SelectTrigger>
              <SelectContent>
                {teams.map((team) => (
                  <SelectItem key={team.id} value={team.id}>
                    <EntityIcon icon={team.icon} name={team.name} color={team.color} />
                    {team.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </FormField>
      )}

      <div className="flex items-end gap-3">
        <div className="flex shrink-0 gap-1.5 pb-px">
          <EmojiPicker value={icon} onChange={setIcon} label="Project icon">
            <Button
              type="button"
              variant="outline"
              size="icon"
              aria-label={icon ? `Project icon: ${icon}` : 'Choose a project icon'}
            >
              <EntityIcon
                icon={icon}
                name={name || 'P'}
                color={color}
                className="size-6 rounded-md text-base"
              />
            </Button>
          </EmojiPicker>
          <ColorPicker value={color} onChange={setColor} label="Project color" />
        </div>
        <FormField label="Name" error={errors.name} className="min-w-0 flex-1">
          {(field) => (
            <Input
              {...field}
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Web app"
              maxLength={LIMITS.projectName.max}
              autoFocus
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
            keyValue={finalKey}
            availability={shownAvailability}
            onUseSuggestion={(suggestion) => {
              setKey(suggestion);
              setKeyEdited(true);
            }}
          />
        }
      >
        {(field) => (
          <ProjectKeyInput
            id={field.id}
            value={finalKey}
            invalid={Boolean(field['aria-invalid'])}
            describedBy={field['aria-describedby']}
            onChange={(value) => {
              setKey(value);
              setKeyEdited(true);
            }}
          />
        )}
      </FormField>

      <FormField
        label="Name your first pipeline"
        error={errors.pipelineName}
        hint="Every task sits in a stage of a pipeline. Change its stages and add pipelines later."
      >
        {(field) => (
          <Input
            {...field}
            value={pipelineName}
            onChange={(event) => setPipelineName(event.target.value)}
            placeholder="e.g. Development"
            maxLength={40}
            autoComplete="off"
            required
          />
        )}
      </FormField>

      <FormField
        label="Its stages"
        hint={PIPELINE_TEMPLATES[template].stages.map((stage) => stage.name).join(' → ')}
      >
        {(field) => (
          <Select
            value={template}
            onValueChange={(value) => setTemplate(value as PipelineTemplateId)}
          >
            <SelectTrigger {...field} className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {PIPELINE_TEMPLATE_LIST.map((option) => (
                <SelectItem key={option.id} value={option.id}>
                  {option.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </FormField>

      <FormField
        label="Description"
        error={errors.description}
        hint={`${description.length}/${LIMITS.projectDescription.max} · Shown on project cards`}
      >
        {(field) => (
          <Textarea
            {...field}
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            placeholder="What is this project about?"
            maxLength={LIMITS.projectDescription.max}
            rows={3}
            className="max-h-40 resize-none"
          />
        )}
      </FormField>

      <FormError message={formError} />

      <DialogFooter>
        <Button type="button" variant="outline" onClick={onDone} disabled={create.isPending}>
          Cancel
        </Button>
        <Button type="submit" disabled={create.isPending || !name.trim()}>
          {create.isPending ? <Spinner /> : null}
          Create project
        </Button>
      </DialogFooter>
    </form>
  );
}
