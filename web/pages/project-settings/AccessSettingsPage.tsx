import {
  ArrowDownIcon,
  ArrowUpIcon,
  CheckIcon,
  InfoIcon,
  MinusIcon,
  PencilIcon,
  PlusIcon,
  ShieldIcon,
  Trash2Icon,
  UserPlusIcon,
  UsersIcon,
  XIcon,
} from 'lucide-react';
import { useState, type FormEvent, type ReactNode } from 'react';
import { toast } from 'sonner';
import { COLOR_PALETTE, LIMITS } from '@shared/constants';
import {
  overrideState,
  PERMISSION_GROUPS,
  PERMISSION_INFO,
  PROJECT_PERMISSIONS,
  type OverrideState,
  type Permission,
} from '@shared/permissions';
import type { MeTeam } from '@shared/schemas/core';
import {
  createProjectRoleInputSchema,
  type OverrideSubjectType,
  type PermissionOverride,
  type ProjectRole,
} from '@shared/schemas/projectAccess';
import type { Member, Role } from '@shared/schemas/teams';
import { FormError, FormField } from '@web/components/auth/FormField';
import { ConfirmDialog } from '@web/components/common/ConfirmDialog';
import { EmptyState } from '@web/components/common/EmptyState';
import { ErrorState } from '@web/components/common/ErrorState';
import { Spinner } from '@web/components/common/Spinner';
import { UserAvatar } from '@web/components/common/UserAvatar';
import { ColorPicker } from '@web/components/pickers/ColorPicker';
import { Badge } from '@web/components/ui/badge';
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
import { Skeleton } from '@web/components/ui/skeleton';
import { ToggleGroup, ToggleGroupItem } from '@web/components/ui/toggle-group';
import { errorMessage, isApiError } from '@web/lib/api';
import { pluralize } from '@web/lib/format';
import { fieldErrors } from '@web/lib/forms';
import { useCanManageProjectAccess, useProjectAccess } from '@web/lib/permissions';
import { useRouteContext } from '@web/lib/routeContext';
import { useDocumentTitle } from '@web/lib/title';
import { cn } from '@web/lib/utils';
import { MemberPicker } from '@web/pages/team-settings/RolePickers';
import { UnsavedChangesBar } from '@web/pages/team-settings/UnsavedChanges';
import { useMembers, useRoles } from '@web/pages/teams/api';
import {
  useCreateProjectRole,
  useDeleteProjectRole,
  useProjectPermissions,
  useProjectRoles,
  useRemovePermissionOverride,
  useReorderProjectRoles,
  useSetPermissionOverride,
  useSetProjectRoleMember,
  useUpdateProjectRole,
} from './accessQueries';
import { ReadOnlyNotice, SettingsCard, SettingsHeader } from './common';

/**
 * Project settings → Access (docs/design/agents-and-pipelines.md §3): the project's roles and
 * their members, and a permissions matrix per subject (team roles, project roles, members) with
 * allow / inherit / deny for each project-level permission. Team roles set the defaults; the
 * overrides here apply to this project only. Changing anything needs Manage project access (or
 * the team's Manage projects), and only permissions the viewer has themselves.
 */
export default function AccessSettingsPage() {
  const { team, project } = useRouteContext();
  useDocumentTitle(['Access', project?.name]);
  if (!team || !project) return null;
  return <Access key={project.id} team={team} projectId={project.id} />;
}

function Access({ team, projectId }: { team: MeTeam; projectId: string }) {
  const canManage = useCanManageProjectAccess(team.id, projectId);
  return (
    <div className="space-y-10">
      <div>
        <SettingsHeader
          title="Access"
          description="Who can see this project and what they can do in it. The team’s roles set the defaults; the overrides below apply to this project only."
        />
        {canManage ? null : <ReadOnlyNotice permission="Manage project access" />}
      </div>
      <ProjectRolesSection team={team} projectId={projectId} canManage={canManage} />
      <PermissionsSection team={team} projectId={projectId} canManage={canManage} />
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Project roles
// ---------------------------------------------------------------------------------------------

type Editing = { mode: 'create' } | { mode: 'edit'; role: ProjectRole } | null;

function ProjectRolesSection({
  team,
  projectId,
  canManage,
}: {
  team: MeTeam;
  projectId: string;
  canManage: boolean;
}) {
  const roles = useProjectRoles(projectId);
  const reorder = useReorderProjectRoles(projectId);
  const remove = useDeleteProjectRole(projectId);
  const [editing, setEditing] = useState<Editing>(null);
  const [deleting, setDeleting] = useState<ProjectRole | null>(null);
  const items = roles.data ?? [];

  const move = (index: number, by: -1 | 1) => {
    const ids = items.map((role) => role.id);
    const [moved] = ids.splice(index, 1);
    if (!moved) return;
    ids.splice(index + by, 0, moved);
    reorder.mutate(ids, { onError: (error) => toast.error(errorMessage(error)) });
  };

  const newButton = canManage ? (
    <Button size="sm" onClick={() => setEditing({ mode: 'create' })}>
      <PlusIcon aria-hidden="true" />
      New role
    </Button>
  ) : null;

  return (
    <section aria-labelledby="project-roles-heading">
      <div className="mb-3 flex flex-wrap items-end justify-between gap-2">
        <div className="space-y-1">
          <h3 id="project-roles-heading" className="text-base font-semibold">
            Project roles
          </h3>
          <p className="text-sm text-muted-foreground">
            Groups of people and agents for this project. They have no permissions of their own:
            give them overrides under Permissions.
          </p>
        </div>
        {items.length > 0 ? newButton : null}
      </div>
      {roles.isError ? (
        <ErrorState
          title="Couldn’t load the project roles"
          error={roles.error}
          onRetry={() => void roles.refetch()}
        />
      ) : roles.isPending ? (
        <div className="space-y-2">
          {[0, 1].map((index) => (
            <Skeleton key={index} className="h-16 w-full" />
          ))}
        </div>
      ) : items.length === 0 ? (
        <EmptyState
          icon={UsersIcon}
          headingLevel={3}
          title="No project roles yet"
          description={
            canManage
              ? 'Create a role such as “Reviewers” or “Contractors”, add members, then set what it may do here.'
              : 'Nobody has created a role for this project yet.'
          }
          action={newButton}
        />
      ) : (
        <SettingsCard>
          <ul>
            {items.map((role, index) => (
              <ProjectRoleRow
                key={role.id}
                team={team}
                projectId={projectId}
                role={role}
                canManage={canManage}
                onEdit={() => setEditing({ mode: 'edit', role })}
                onDelete={() => setDeleting(role)}
                onMove={
                  canManage
                    ? {
                        up: index > 0 ? () => move(index, -1) : null,
                        down: index < items.length - 1 ? () => move(index, 1) : null,
                      }
                    : null
                }
              />
            ))}
          </ul>
        </SettingsCard>
      )}
      <ProjectRoleDialog
        projectId={projectId}
        editing={editing}
        existing={items}
        onClose={() => setEditing(null)}
      />
      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => (open ? undefined : setDeleting(null))}
        title={`Delete the role “${deleting?.name ?? ''}”?`}
        description={`${
          deleting?.members.length
            ? `${pluralize(deleting.members.length, 'member')} will lose it, and its`
            : 'Its'
        } permission override in this project goes with it. This can’t be undone.`}
        confirmLabel="Delete role"
        destructive
        onConfirm={async () => {
          if (!deleting) return;
          await remove.mutateAsync(deleting.id);
          toast.success(`Deleted ${deleting.name}`);
        }}
      />
    </section>
  );
}

function RoleDot({ color }: { color: string | null }) {
  return (
    <span
      aria-hidden="true"
      className="size-3 shrink-0 rounded-full border"
      style={{ backgroundColor: color ?? 'var(--muted-foreground)' }}
    />
  );
}

function ProjectRoleRow({
  team,
  projectId,
  role,
  canManage,
  onEdit,
  onDelete,
  onMove,
}: {
  team: MeTeam;
  projectId: string;
  role: ProjectRole;
  canManage: boolean;
  onEdit: () => void;
  onDelete: () => void;
  onMove: { up: (() => void) | null; down: (() => void) | null } | null;
}) {
  const members = useMembers(canManage ? team.id : undefined);
  const setMember = useSetProjectRoleMember(projectId);
  const holders = new Set(role.members.map((member) => member.id));
  const candidates = (members.data?.items ?? []).filter((member) => !holders.has(member.user.id));

  const change = (userId: string, name: string, assign: boolean) =>
    setMember.mutate(
      { roleId: role.id, userId, assign },
      {
        onSuccess: () =>
          toast.success(assign ? `Gave ${role.name} to ${name}` : `Took ${role.name} from ${name}`),
        onError: (error) => toast.error(errorMessage(error)),
      },
    );

  return (
    <li className="border-b px-4 py-3 last:border-b-0" data-testid="project-role-row">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <RoleDot color={role.color} />
        <span className="min-w-0 flex-1 truncate font-medium">{role.name}</span>
        <span className="text-xs text-muted-foreground tabular-nums">
          {pluralize(role.members.length, 'member')}
        </span>
        {canManage ? (
          <div className="flex shrink-0 gap-1">
            {onMove ? (
              <>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`Move ${role.name} up`}
                  disabled={!onMove.up}
                  onClick={() => onMove.up?.()}
                >
                  <ArrowUpIcon aria-hidden="true" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`Move ${role.name} down`}
                  disabled={!onMove.down}
                  onClick={() => onMove.down?.()}
                >
                  <ArrowDownIcon aria-hidden="true" />
                </Button>
              </>
            ) : null}
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={`Edit ${role.name}`}
              onClick={onEdit}
            >
              <PencilIcon aria-hidden="true" />
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={`Delete ${role.name}`}
              className="text-muted-foreground hover:text-destructive"
              onClick={onDelete}
            >
              <Trash2Icon aria-hidden="true" />
            </Button>
          </div>
        ) : null}
      </div>
      <ul
        className="mt-2 flex flex-wrap items-center gap-1.5"
        aria-label={`Members of ${role.name}`}
      >
        {role.members.map((member) => (
          <li
            key={member.id}
            className="flex items-center gap-1.5 rounded-full border bg-muted/40 py-0.5 pr-1 pl-0.5 text-xs"
          >
            <UserAvatar user={member} size="xs" />
            <span>{member.name}</span>
            {member.isAgent ? (
              <Badge variant="secondary" className="px-1 py-0 text-[10px]">
                AI
              </Badge>
            ) : null}
            {canManage ? (
              <button
                type="button"
                className="rounded-full p-0.5 text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
                aria-label={`Remove ${member.name} from ${role.name}`}
                onClick={() => change(member.id, member.name, false)}
              >
                <XIcon className="size-3" aria-hidden="true" />
              </button>
            ) : null}
          </li>
        ))}
        {role.members.length === 0 && !canManage ? (
          <li className="text-xs text-muted-foreground">No members yet</li>
        ) : null}
        {canManage ? (
          <li>
            <MemberPicker
              members={candidates}
              refusalFor={() => null}
              onPick={(member: Member) => change(member.user.id, member.user.name, true)}
            >
              <Button variant="ghost" size="sm" className="h-6 px-2 text-xs">
                <UserPlusIcon aria-hidden="true" />
                Add member
              </Button>
            </MemberPicker>
          </li>
        ) : null}
      </ul>
    </li>
  );
}

function nextColor(existing: readonly ProjectRole[]): string {
  const used = new Set(existing.map((role) => role.color));
  return (COLOR_PALETTE.slice(1).find((color) => !used.has(color.hex)) ?? COLOR_PALETTE[0]).hex;
}

function ProjectRoleDialog({
  projectId,
  editing,
  existing,
  onClose,
}: {
  projectId: string;
  editing: Editing;
  existing: ProjectRole[];
  onClose: () => void;
}) {
  return (
    <Dialog open={editing !== null} onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent className="sm:max-w-md">
        {editing ? (
          <ProjectRoleForm
            projectId={projectId}
            editing={editing}
            existing={existing}
            onClose={onClose}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function ProjectRoleForm({
  projectId,
  editing,
  existing,
  onClose,
}: {
  projectId: string;
  editing: NonNullable<Editing>;
  existing: ProjectRole[];
  onClose: () => void;
}) {
  const create = useCreateProjectRole(projectId);
  const update = useUpdateProjectRole(projectId);
  const initial = editing.mode === 'edit' ? editing.role : null;
  const [name, setName] = useState(initial?.name ?? '');
  const [color, setColor] = useState(initial?.color ?? nextColor(existing));
  const [nameError, setNameError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const pending = create.isPending || update.isPending;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (pending) return;
    setFormError(null);
    const parsed = createProjectRoleInputSchema.safeParse({ name, color });
    if (!parsed.success) {
      setNameError(fieldErrors<'name'>(parsed.error).name ?? null);
      return;
    }
    setNameError(null);
    const onError = (cause: Error) => {
      if (isApiError(cause) && cause.code === 'validation_failed') setNameError(cause.message);
      else setFormError(errorMessage(cause));
    };
    const done = (message: string) => {
      toast.success(message);
      onClose();
    };
    if (initial) {
      update.mutate(
        { id: initial.id, input: parsed.data },
        { onSuccess: (role) => done(`Saved ${role.name}`), onError },
      );
    } else {
      create.mutate(parsed.data, {
        onSuccess: (role) => done(`Created ${role.name}`),
        onError,
      });
    }
  };

  return (
    <form onSubmit={submit} className="grid gap-4" noValidate>
      <DialogHeader>
        <DialogTitle>{initial ? 'Edit project role' : 'New project role'}</DialogTitle>
        <DialogDescription>
          Project roles exist in this project only. Set what they may do under Permissions.
        </DialogDescription>
      </DialogHeader>
      <div className="flex items-end gap-3">
        <FormField label="Name" error={nameError} className="min-w-0 flex-1">
          {(field) => (
            <Input
              {...field}
              value={name}
              onChange={(event) => setName(event.target.value)}
              maxLength={LIMITS.roleName.max}
              placeholder="Reviewers"
              autoFocus
              autoComplete="off"
            />
          )}
        </FormField>
        <div className="grid gap-1.5 pb-px">
          <span className="text-sm leading-none font-medium" aria-hidden="true">
            Color
          </span>
          <ColorPicker value={color} onChange={setColor} label="Role color">
            <Button type="button" variant="outline" size="icon" aria-label={`Role color: ${color}`}>
              <span className="size-4 rounded-full border" style={{ backgroundColor: color }} />
            </Button>
          </ColorPicker>
        </div>
      </div>
      <FormError message={formError} />
      <DialogFooter>
        <Button type="button" variant="ghost" onClick={onClose} disabled={pending}>
          Cancel
        </Button>
        <Button type="submit" disabled={pending}>
          {pending ? <Spinner /> : null}
          {initial ? 'Save' : 'Create role'}
        </Button>
      </DialogFooter>
    </form>
  );
}

// ---------------------------------------------------------------------------------------------
// Permissions matrix
// ---------------------------------------------------------------------------------------------

interface Subject {
  type: OverrideSubjectType;
  id: string;
  name: string;
  color: string | null;
  /** Holders of ADMINISTRATOR bypass overrides; the matrix says so. */
  isAdmin?: boolean;
}

const subjectKey = (subject: { type: OverrideSubjectType; id: string }) =>
  `${subject.type}:${subject.id}`;

function PermissionsSection({
  team,
  projectId,
  canManage,
}: {
  team: MeTeam;
  projectId: string;
  canManage: boolean;
}) {
  const permissions = useProjectPermissions(projectId);
  const teamRoles = useRoles(team.id);
  const projectRoles = useProjectRoles(projectId);
  const members = useMembers(team.id);
  const [selected, setSelected] = useState<string | null>(null);
  const [extraMembers, setExtraMembers] = useState<Subject[]>([]);

  if (permissions.isError || teamRoles.isError) {
    const failed = permissions.isError ? permissions : teamRoles;
    return (
      <ErrorState
        title="Couldn’t load the permissions"
        error={failed.error}
        onRetry={() => void failed.refetch()}
      />
    );
  }
  if (permissions.isPending || teamRoles.isPending) {
    return <Skeleton className="h-96 w-full" />;
  }

  const overrides = permissions.data.overrides;
  const roles: Role[] = [...teamRoles.data.items].sort(
    (a, b) => Number(b.isEveryone) - Number(a.isEveryone) || b.position - a.position,
  );
  const teamSubjects: Subject[] = roles.map((role) => ({
    type: 'team_role',
    id: role.id,
    name: role.name,
    color: role.color,
    isAdmin: role.permissions.includes('ADMINISTRATOR'),
  }));
  const projectSubjects: Subject[] = (projectRoles.data ?? []).map((role) => ({
    type: 'project_role',
    id: role.id,
    name: role.name,
    color: role.color,
  }));
  const memberSubjects: Subject[] = [
    ...overrides
      .filter((o) => o.subjectType === 'user')
      .map((o): Subject => ({ type: 'user', id: o.subjectId, name: o.subjectName, color: null })),
    ...extraMembers.filter(
      (extra) => !overrides.some((o) => o.subjectType === 'user' && o.subjectId === extra.id),
    ),
  ];
  const all = [...teamSubjects, ...projectSubjects, ...memberSubjects];
  const current = all.find((subject) => subjectKey(subject) === selected) ?? all[0] ?? null;
  const overrideOf = (subject: Subject) =>
    overrides.find((o) => o.subjectType === subject.type && o.subjectId === subject.id) ?? null;
  const memberCandidates = (members.data?.items ?? []).filter(
    (member) => !memberSubjects.some((subject) => subject.id === member.user.id),
  );

  const group = (title: string, subjects: Subject[], extra?: ReactNode) => (
    <div className="space-y-1">
      <p className="px-2 pt-2 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
        {title}
      </p>
      {subjects.map((subject) => {
        const active = current !== null && subjectKey(subject) === subjectKey(current);
        const changed = overrideOf(subject);
        return (
          <button
            key={subjectKey(subject)}
            type="button"
            aria-pressed={active}
            onClick={() => setSelected(subjectKey(subject))}
            className={cn(
              'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring',
              active ? 'bg-accent text-accent-foreground' : 'hover:bg-accent/60',
            )}
          >
            {subject.type === 'user' ? (
              <UsersIcon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
            ) : (
              <RoleDot color={subject.color} />
            )}
            <span className="min-w-0 flex-1 truncate">{subject.name}</span>
            {changed ? (
              <span className="text-[11px] text-muted-foreground">
                {changed.allow.length + changed.deny.length} set
              </span>
            ) : null}
          </button>
        );
      })}
      {extra}
    </div>
  );

  return (
    <section aria-labelledby="project-permissions-heading">
      <div className="mb-3 space-y-1">
        <h3 id="project-permissions-heading" className="text-base font-semibold">
          Permissions
        </h3>
        <p className="text-sm text-muted-foreground">
          Allow or deny project permissions for a team role, a project role or one member. Order:
          team roles’ defaults, then @everyone, then roles (denies before allows), then the member.
          The owner and administrators always have every permission.
        </p>
      </div>
      <div className="grid gap-4 md:grid-cols-[13rem_minmax(0,1fr)]">
        <nav aria-label="Permission subjects" className="rounded-lg border p-1">
          {group('Team roles', teamSubjects)}
          {projectSubjects.length > 0 ? group('Project roles', projectSubjects) : null}
          {group(
            'Members',
            memberSubjects,
            canManage ? (
              <MemberPicker
                members={memberCandidates}
                refusalFor={() => null}
                onPick={(member: Member) => {
                  const subject: Subject = {
                    type: 'user',
                    id: member.user.id,
                    name: `@${member.user.username}`,
                    color: null,
                  };
                  setExtraMembers((list) => [...list, subject]);
                  setSelected(subjectKey(subject));
                }}
              >
                <Button variant="ghost" size="sm" className="w-full justify-start">
                  <UserPlusIcon aria-hidden="true" />
                  Add member
                </Button>
              </MemberPicker>
            ) : null,
          )}
        </nav>
        {current ? (
          <SubjectMatrix
            key={`${subjectKey(current)}:${overrideOf(current)?.updatedAt ?? ''}`}
            team={team}
            projectId={projectId}
            subject={current}
            override={overrideOf(current)}
            canManage={canManage}
          />
        ) : (
          <EmptyState
            icon={ShieldIcon}
            headingLevel={3}
            title="Nothing to set yet"
            description="Pick a role or a member to set their permissions in this project."
          />
        )}
      </div>
    </section>
  );
}

interface Draft {
  allow: Permission[];
  deny: Permission[];
}

function SubjectMatrix({
  team,
  projectId,
  subject,
  override,
  canManage,
}: {
  team: MeTeam;
  projectId: string;
  subject: Subject;
  override: PermissionOverride | null;
  canManage: boolean;
}) {
  const access = useProjectAccess(team.id, projectId);
  const set = useSetPermissionOverride(projectId);
  const remove = useRemovePermissionOverride(projectId);
  const saved: Draft = { allow: override?.allow ?? [], deny: override?.deny ?? [] };
  const [draft, setDraft] = useState<Draft>(saved);
  const dirty =
    draft.allow.join() !== saved.allow.join() || draft.deny.join() !== saved.deny.join();
  const isAdminViewer = access.isOwner || access.has('ADMINISTRATOR');
  const saving = set.isPending || remove.isPending;

  const change = (permission: Permission, state: OverrideState) => {
    const allow = draft.allow.filter((p) => p !== permission);
    const deny = draft.deny.filter((p) => p !== permission);
    if (state === 'allow') allow.push(permission);
    if (state === 'deny') deny.push(permission);
    const order = (list: Permission[]) => PROJECT_PERMISSIONS.filter((p) => list.includes(p));
    setDraft({ allow: order(allow), deny: order(deny) });
  };

  // Saving refetches the override, which remounts this matrix (its key has `updatedAt`), so the
  // toasts follow the promise instead of per-call callbacks (those are skipped once unmounted).
  const save = () =>
    set.mutateAsync({ subjectType: subject.type, subjectId: subject.id, ...draft }).then(
      () => toast.success(`Saved permissions for ${subject.name}`),
      (error: unknown) => toast.error(errorMessage(error)),
    );

  return (
    <div className="min-w-0">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h4 className="flex items-center gap-2 text-sm font-semibold">
          {subject.type === 'user' ? null : <RoleDot color={subject.color} />}
          {subject.name}
          <Badge variant="outline" className="font-normal text-muted-foreground">
            {subject.type === 'team_role'
              ? 'Team role'
              : subject.type === 'project_role'
                ? 'Project role'
                : 'Member'}
          </Badge>
        </h4>
        {canManage && override ? (
          <Button
            variant="ghost"
            size="sm"
            disabled={saving}
            onClick={() =>
              void remove.mutateAsync({ subjectType: subject.type, subjectId: subject.id }).then(
                () => toast.success(`${subject.name} inherits everything again`),
                (error: unknown) => toast.error(errorMessage(error)),
              )
            }
          >
            Reset to inherit
          </Button>
        ) : null}
      </div>
      {subject.isAdmin ? (
        <p className="mb-3 flex items-start gap-2 rounded-md border bg-muted/50 px-3 py-2 text-sm text-muted-foreground">
          <InfoIcon className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          This role has Administrator: its members have every permission, whatever is set here.
        </p>
      ) : null}
      <div className="space-y-5">
        {PERMISSION_GROUPS.map((group) => {
          const list = PROJECT_PERMISSIONS.filter((p) => PERMISSION_INFO[p].group === group.id);
          if (list.length === 0) return null;
          return (
            <section key={group.id} aria-label={group.label}>
              <p className="pb-2 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
                {group.label}
              </p>
              <ul className="divide-y rounded-lg border">
                {list.map((permission) => {
                  const info = PERMISSION_INFO[permission];
                  const state = overrideState(draft, permission);
                  const lacks = !isAdminViewer && !access.has(permission);
                  return (
                    <li
                      key={permission}
                      className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 px-4 py-3"
                      data-testid={`permission-${permission}`}
                    >
                      <div className="min-w-0 flex-1 space-y-0.5">
                        <p className="text-sm font-medium">{info.label}</p>
                        <p className="text-xs text-muted-foreground">
                          {info.description}
                          {lacks && canManage
                            ? ' You can’t change it: you don’t have it here.'
                            : ''}
                        </p>
                      </div>
                      <ToggleGroup
                        type="single"
                        variant="outline"
                        size="sm"
                        value={state}
                        onValueChange={(value) => {
                          if (value) change(permission, value as OverrideState);
                        }}
                        disabled={!canManage || lacks || saving}
                        aria-label={`${info.label} for ${subject.name}`}
                      >
                        <ToggleGroupItem
                          value="deny"
                          aria-label={`Deny ${info.label}`}
                          className="data-[state=on]:bg-destructive/15 data-[state=on]:text-destructive"
                        >
                          <XIcon aria-hidden="true" />
                        </ToggleGroupItem>
                        <ToggleGroupItem value="inherit" aria-label={`Inherit ${info.label}`}>
                          <MinusIcon aria-hidden="true" />
                        </ToggleGroupItem>
                        <ToggleGroupItem
                          value="allow"
                          aria-label={`Allow ${info.label}`}
                          className="data-[state=on]:bg-emerald-500/15 data-[state=on]:text-emerald-700 dark:data-[state=on]:text-emerald-400"
                        >
                          <CheckIcon aria-hidden="true" />
                        </ToggleGroupItem>
                      </ToggleGroup>
                    </li>
                  );
                })}
              </ul>
            </section>
          );
        })}
      </div>
      <UnsavedChangesBar
        dirty={dirty}
        saving={saving}
        onSave={() => void save()}
        onReset={() => setDraft(saved)}
      />
    </div>
  );
}
