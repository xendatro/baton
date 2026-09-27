import {
  InfoIcon,
  LockIcon,
  ShieldAlertIcon,
  Trash2Icon,
  UserPlusIcon,
  UsersIcon,
  XIcon,
} from 'lucide-react';
import { useId, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { toast } from 'sonner';
import { LIMITS } from '@shared/constants';
import {
  normalizePermissions,
  PERMISSION_GROUPS,
  PERMISSION_INFO,
  PERMISSIONS,
  type Permission,
} from '@shared/permissions';
import type { MeTeam } from '@shared/schemas/core';
import { roleNameSchema, type Member, type Role } from '@shared/schemas/teams';
import { FormField } from '@web/components/auth/FormField';
import { BackLink } from '@web/components/common/BackLink';
import { ConfirmDialog } from '@web/components/common/ConfirmDialog';
import { EmptyState } from '@web/components/common/EmptyState';
import { ErrorState } from '@web/components/common/ErrorState';
import { UserAvatar } from '@web/components/common/UserAvatar';
import { ColorPicker } from '@web/components/pickers/ColorPicker';
import { Badge } from '@web/components/ui/badge';
import { Button } from '@web/components/ui/button';
import { Input } from '@web/components/ui/input';
import { Skeleton } from '@web/components/ui/skeleton';
import { Switch } from '@web/components/ui/switch';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@web/components/ui/tabs';
import { Tooltip, TooltipContent, TooltipTrigger } from '@web/components/ui/tooltip';
import { errorMessage } from '@web/lib/api';
import { readableTextColor } from '@web/lib/colors';
import { pluralize } from '@web/lib/format';
import { useTheme } from '@web/lib/theme';
import { useDocumentTitle } from '@web/lib/title';
import { cn } from '@web/lib/utils';
import {
  memberPermissions,
  roleAssignRefusal,
  roleManageRefusal,
  type Viewer,
} from '@web/pages/teams/access';
import {
  useDeleteRole,
  useMembers,
  useRoles,
  useSetMemberRole,
  useUpdateRole,
} from '@web/pages/teams/api';
import { useSettingsTeam, useViewer } from './context';
import { MemberPicker } from './RolePickers';
import { UnsavedChangesBar } from './UnsavedChanges';
import { useUnsavedChangesGuard } from './useUnsavedChangesGuard';

const TABS = ['display', 'permissions', 'members'] as const;
type Tab = (typeof TABS)[number];

/** `/t/:team/settings/roles/:roleId`: the Discord-style role editor, under a "← Roles" back link. */
export default function RoleEditPage() {
  const team = useSettingsTeam();
  const { roleId } = useParams();
  const roles = useRoles(team.id);
  const role = roles.data?.items.find((candidate) => candidate.id === roleId);
  useDocumentTitle([role ? `${role.name} role` : 'Role', team.name]);

  if (roles.isPending) return <EditorSkeleton />;
  if (roles.isError) {
    return (
      <ErrorState
        title="Couldn’t load the role"
        error={roles.error}
        onRetry={() => void roles.refetch()}
      />
    );
  }
  if (!role) {
    return (
      <EmptyState
        icon={ShieldAlertIcon}
        title="Role not found"
        description="It may have been deleted."
        action={
          <Button variant="outline" asChild>
            <Link to={`/t/${team.slug}/settings/roles`}>Back to roles</Link>
          </Button>
        }
      />
    );
  }
  return (
    <div>
      <BackLink to={`/t/${team.slug}/settings/roles`} label="Roles" />
      <div className="grid gap-6 lg:grid-cols-[12rem_minmax(0,1fr)]">
        <RoleNav team={team} roles={roles.data.items} activeId={role.id} />
        <RoleEditor key={role.id} team={team} role={role} roles={roles.data.items} />
      </div>
    </div>
  );
}

function RoleNav({ team, roles, activeId }: { team: MeTeam; roles: Role[]; activeId: string }) {
  return (
    <nav aria-label="Roles" className="hidden lg:block">
      <ul className="space-y-0.5">
        {roles.map((role) => (
          <li key={role.id}>
            <Link
              to={`/t/${team.slug}/settings/roles/${role.id}`}
              aria-current={role.id === activeId ? 'page' : undefined}
              className={cn(
                'flex items-center gap-2 rounded-md px-2 py-1.5 text-sm outline-none hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/50',
                role.id === activeId && 'bg-accent font-medium',
              )}
            >
              <span
                aria-hidden="true"
                className="size-2.5 shrink-0 rounded-full border"
                style={{ backgroundColor: role.color ?? 'transparent' }}
              />
              <span className="truncate">{role.name}</span>
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}

interface Draft {
  name: string;
  color: string | null;
  mentionable: boolean;
  permissions: Permission[];
}

function toDraft(role: Role): Draft {
  return {
    name: role.name,
    color: role.color,
    mentionable: role.mentionable,
    permissions: normalizePermissions(role.permissions),
  };
}

function sameDraft(a: Draft, b: Draft): boolean {
  return (
    a.name === b.name &&
    a.color === b.color &&
    a.mentionable === b.mentionable &&
    a.permissions.join() === b.permissions.join()
  );
}

function RoleEditor({ team, role, roles }: { team: MeTeam; role: Role; roles: Role[] }) {
  const navigate = useNavigate();
  const viewer = useViewer(team);
  const [params, setParams] = useSearchParams();
  const requested = params.get('tab');
  const tab: Tab =
    TABS.includes(requested as Tab) && !(role.isEveryone && requested === 'members')
      ? (requested as Tab)
      : 'display';
  const updateRole = useUpdateRole(team.id, role.id);
  const deleteRole = useDeleteRole(team.id);
  const [baseline, setBaseline] = useState(() => toDraft(role));
  const [draft, setDraft] = useState(baseline);
  const [syncedAt, setSyncedAt] = useState(role.updatedAt);
  const [nameError, setNameError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const dirty = !sameDraft(draft, baseline);
  const guard = useUnsavedChangesGuard(dirty);
  if (role.updatedAt !== syncedAt && !dirty) {
    setSyncedAt(role.updatedAt);
    setBaseline(toDraft(role));
    setDraft(toDraft(role));
  }

  const refusal = roleManageRefusal(viewer, role.permissions);
  const readOnly = refusal !== null;

  const save = () => {
    const name = roleNameSchema.safeParse(draft.name);
    if (!role.isEveryone && !name.success) {
      setNameError(name.error.issues[0]?.message ?? 'Check the name');
      setParams({ tab: 'display' }, { replace: true });
      return;
    }
    const patch = role.isEveryone
      ? { permissions: draft.permissions }
      : {
          ...(draft.name !== baseline.name && name.success ? { name: name.data } : {}),
          ...(draft.color !== baseline.color ? { color: draft.color } : {}),
          ...(draft.mentionable !== baseline.mentionable ? { mentionable: draft.mentionable } : {}),
          ...(draft.permissions.join() !== baseline.permissions.join()
            ? { permissions: draft.permissions }
            : {}),
        };
    updateRole.mutate(patch, {
      onSuccess: (saved) => {
        const next = toDraft(saved);
        setBaseline(next);
        setDraft(next);
        setSyncedAt(saved.updatedAt);
        toast.success(`Saved ${saved.name}`);
      },
      onError: (error) => toast.error(errorMessage(error)),
    });
  };

  return (
    <div className="min-w-0">
      <div className="flex flex-wrap items-start justify-between gap-3 pb-4">
        <div className="flex min-w-0 items-center gap-3">
          <span
            aria-hidden="true"
            className="size-4 shrink-0 rounded-full border"
            style={{ backgroundColor: draft.color ?? 'transparent' }}
          />
          <div className="min-w-0">
            <h2 className="truncate text-lg font-semibold tracking-tight">
              Edit role: {role.isEveryone ? '@everyone' : draft.name || role.name}
            </h2>
            <p className="text-sm text-muted-foreground">
              {role.isEveryone
                ? 'Permissions every member of the team has.'
                : `${pluralize(role.memberCount, 'member')} · mention with @&${role.slug}`}
            </p>
          </div>
        </div>
        {!role.isEveryone && !readOnly ? (
          <Button variant="outline" size="sm" onClick={() => setConfirmDelete(true)}>
            <Trash2Icon aria-hidden="true" />
            Delete role
          </Button>
        ) : null}
      </div>

      {readOnly ? (
        <p className="mb-4 flex items-start gap-2 rounded-md border bg-muted/50 px-3 py-2 text-sm text-muted-foreground">
          <LockIcon className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          <span>You can view this role but not change it. {refusal}.</span>
        </p>
      ) : null}

      <Tabs value={tab} onValueChange={(value) => setParams({ tab: value }, { replace: true })}>
        <TabsList variant="line" className="mb-4 w-full justify-start border-b">
          <TabsTrigger value="display" className="flex-none">
            Display
          </TabsTrigger>
          <TabsTrigger value="permissions" className="flex-none">
            Permissions
          </TabsTrigger>
          {!role.isEveryone ? (
            <TabsTrigger value="members" className="flex-none">
              Members ({role.memberCount})
            </TabsTrigger>
          ) : null}
        </TabsList>
        <TabsContent value="display">
          <DisplayTab
            role={role}
            draft={draft}
            onChange={(patch) => {
              setDraft((current) => ({ ...current, ...patch }));
              if (patch.name !== undefined) setNameError(null);
            }}
            nameError={nameError}
            disabled={readOnly || updateRole.isPending}
            onSubmit={() => {
              if (dirty) save();
            }}
          />
        </TabsContent>
        <TabsContent value="permissions">
          <PermissionsTab
            viewer={viewer}
            draft={draft}
            onChange={(permissions) => setDraft((current) => ({ ...current, permissions }))}
            disabled={readOnly || updateRole.isPending}
          />
        </TabsContent>
        {!role.isEveryone ? (
          <TabsContent value="members">
            <MembersTab team={team} viewer={viewer} role={role} roles={roles} />
          </TabsContent>
        ) : null}
      </Tabs>

      {!readOnly ? (
        <UnsavedChangesBar
          dirty={dirty}
          saving={updateRole.isPending}
          canSave={role.isEveryone || draft.name.trim().length > 0}
          onSave={save}
          onReset={() => {
            setDraft(baseline);
            setNameError(null);
          }}
        />
      ) : null}
      {guard.dialog}
      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title={`Delete the ${role.name} role?`}
        description={
          role.memberCount > 0
            ? `${pluralize(role.memberCount, 'member')} will lose it, along with its permissions. Tasks assigned to the role lose that assignee. This can’t be undone.`
            : 'Tasks assigned to the role lose that assignee. This can’t be undone.'
        }
        confirmLabel="Delete role"
        destructive
        onConfirm={async () => {
          await deleteRole.mutateAsync(role.id);
          guard.allowNavigation();
          toast.success(`Deleted the ${role.name} role`);
          await navigate(`/t/${team.slug}/settings/roles`);
        }}
      />
    </div>
  );
}

function DisplayTab({
  role,
  draft,
  onChange,
  nameError,
  disabled,
  onSubmit,
}: {
  role: Role;
  draft: Draft;
  onChange: (patch: Partial<Draft>) => void;
  nameError: string | null;
  disabled: boolean;
  onSubmit: () => void;
}) {
  const mentionableId = useId();
  if (role.isEveryone) {
    return (
      <p className="flex items-start gap-2 rounded-lg border px-4 py-3 text-sm text-muted-foreground">
        <InfoIcon className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
        @everyone is built in: every member has it, and it can’t be renamed, colored, mentioned like
        other roles (that takes the Mention everyone permission) or deleted. You can change its
        permissions.
      </p>
    );
  }
  return (
    <form
      className="grid max-w-xl gap-5"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit();
      }}
    >
      <FormField label="Role name" error={nameError}>
        {(field) => (
          <Input
            {...field}
            value={draft.name}
            onChange={(event) => onChange({ name: event.target.value })}
            maxLength={LIMITS.roleName.max}
            disabled={disabled}
            autoComplete="off"
          />
        )}
      </FormField>
      <div className="grid gap-2">
        <p className="text-sm font-medium">Color</p>
        <p className="-mt-1 text-xs text-muted-foreground">
          Members show in the color of their highest colored role.
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <ColorPicker
            value={draft.color ?? '#6b7280'}
            onChange={(color) => onChange({ color })}
            label="Role color"
            disabled={disabled}
          >
            <Button type="button" variant="outline" size="sm" disabled={disabled}>
              <span
                aria-hidden="true"
                className="size-4 rounded-full border"
                style={{ backgroundColor: draft.color ?? 'transparent' }}
              />
              {draft.color ? (
                <span className="font-mono text-xs">{draft.color}</span>
              ) : (
                'Choose a color'
              )}
            </Button>
          </ColorPicker>
          {draft.color ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={disabled}
              onClick={() => onChange({ color: null })}
            >
              No color
            </Button>
          ) : null}
        </div>
      </div>
      <div className="flex items-start justify-between gap-4 rounded-lg border px-4 py-3">
        <div className="space-y-0.5">
          <label htmlFor={mentionableId} className="text-sm font-medium">
            Allow anyone to @mention this role
          </label>
          <p className="text-xs text-muted-foreground">
            Members with Mention everyone can always mention it. Mentions notify everyone with the
            role.
          </p>
        </div>
        <Switch
          id={mentionableId}
          checked={draft.mentionable}
          onCheckedChange={(mentionable) => onChange({ mentionable })}
          disabled={disabled}
        />
      </div>
    </form>
  );
}

function PermissionsTab({
  viewer,
  draft,
  onChange,
  disabled,
}: {
  viewer: Viewer;
  draft: Draft;
  onChange: (permissions: Permission[]) => void;
  disabled: boolean;
}) {
  const isAdminViewer = viewer.isOwner || viewer.permissions.includes('ADMINISTRATOR');
  const has = new Set(draft.permissions);
  const grantsAll = has.has('ADMINISTRATOR');

  const set = (permission: Permission, on: boolean) => {
    const next = new Set(has);
    if (on) next.add(permission);
    else next.delete(permission);
    onChange(normalizePermissions(next));
  };

  return (
    <div className="space-y-6">
      <div className="flex min-h-8 flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground">
          {pluralize(draft.permissions.length, 'permission')} granted
        </p>
        {draft.permissions.length > 0 && !disabled ? (
          <Button variant="ghost" size="sm" onClick={() => onChange([])}>
            Clear permissions
          </Button>
        ) : null}
      </div>
      {grantsAll ? (
        <p className="flex items-start gap-2 rounded-md border bg-muted/50 px-3 py-2 text-sm text-muted-foreground">
          <InfoIcon className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          Administrator grants every permission below, whether or not it is switched on.
        </p>
      ) : null}
      {PERMISSION_GROUPS.map((group) => {
        const permissions = PERMISSIONS.filter((p) => PERMISSION_INFO[p].group === group.id);
        return (
          <section key={group.id} aria-labelledby={`group-${group.id}`}>
            <h3
              id={`group-${group.id}`}
              className="pb-2 text-xs font-semibold tracking-wide text-muted-foreground uppercase"
            >
              {group.label}
            </h3>
            <ul className="divide-y rounded-lg border">
              {permissions.map((permission) => {
                const info = PERMISSION_INFO[permission];
                const checked = has.has(permission);
                const lacks = !isAdminViewer && !viewer.permissions.includes(permission);
                const blocked = lacks && !checked;
                const reason =
                  permission === 'ADMINISTRATOR' && !isAdminViewer
                    ? 'Only administrators can grant Administrator'
                    : 'You can’t grant a permission you don’t have';
                return (
                  <PermissionRow
                    key={permission}
                    label={info.label}
                    description={info.description}
                    projectDefault={info.scope === 'project'}
                    checked={checked}
                    disabled={disabled || blocked}
                    reason={!disabled && blocked ? reason : null}
                    onChange={(on) => set(permission, on)}
                  />
                );
              })}
            </ul>
          </section>
        );
      })}
    </div>
  );
}

function PermissionRow({
  label,
  description,
  projectDefault,
  checked,
  disabled,
  reason,
  onChange,
}: {
  label: string;
  description: string;
  /** A project-level permission: the role's value is the default each project can override. */
  projectDefault: boolean;
  checked: boolean;
  disabled: boolean;
  reason: string | null;
  onChange: (on: boolean) => void;
}) {
  const id = useId();
  const toggle = (
    <Switch
      id={id}
      checked={checked}
      onCheckedChange={onChange}
      disabled={disabled}
      aria-describedby={`${id}-description`}
    />
  );
  return (
    <li className="flex items-start justify-between gap-4 px-4 py-3">
      <div className="min-w-0 space-y-0.5">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <label htmlFor={id} className="text-sm font-medium">
            {label}
          </label>
          <Badge
            variant="outline"
            className="px-1.5 py-0 text-[11px] font-normal text-muted-foreground"
          >
            {projectDefault ? 'Default for projects' : 'Team-wide'}
          </Badge>
        </div>
        <p id={`${id}-description`} className="text-xs text-muted-foreground">
          {description}
          {projectDefault ? ' Projects can override it in their Access settings.' : ''}
        </p>
      </div>
      {reason ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <span
              tabIndex={0}
              className="rounded-full outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
              aria-label={`${label}: ${reason}`}
            >
              {toggle}
            </span>
          </TooltipTrigger>
          <TooltipContent>{reason}</TooltipContent>
        </Tooltip>
      ) : (
        toggle
      )}
    </li>
  );
}

function MembersTab({
  team,
  viewer,
  role,
  roles,
}: {
  team: MeTeam;
  viewer: Viewer;
  role: Role;
  roles: Role[];
}) {
  const members = useMembers(team.id);
  const setRole = useSetMemberRole(team.id);
  const [query, setQuery] = useState('');
  const { resolvedTheme } = useTheme();
  if (members.isPending) {
    return (
      <div className="space-y-2">
        {[0, 1, 2].map((index) => (
          <Skeleton key={index} className="h-12 w-full" />
        ))}
      </div>
    );
  }
  if (members.isError) {
    return (
      <ErrorState
        title="Couldn’t load members"
        error={members.error}
        onRetry={() => void members.refetch()}
      />
    );
  }
  const refusalFor = (member: Member) =>
    roleAssignRefusal(viewer, role, {
      ...memberPermissions(member, roles),
      userId: member.user.id,
    });
  const holders = members.data.items.filter((member) =>
    member.roles.some((candidate) => candidate.id === role.id),
  );
  const candidates = members.data.items.filter((member) => !holders.includes(member));
  const q = query.trim().toLowerCase();
  const shown = holders.filter(
    (member) =>
      !q || member.user.name.toLowerCase().includes(q) || member.user.username.includes(q),
  );
  const change = (member: Member, assigned: boolean) =>
    setRole.mutate(
      { userId: member.user.id, role, assigned },
      {
        onSuccess: () =>
          toast.success(
            assigned
              ? `Gave ${member.user.name} the ${role.name} role`
              : `Removed ${role.name} from ${member.user.name}`,
          ),
      },
    );
  const canAddAny = candidates.some((member) => refusalFor(member) === null);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Input
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search members with this role"
          aria-label="Search members with this role"
          className="max-w-xs flex-1"
        />
        {canAddAny ? (
          <div className="ml-auto">
            <MemberPicker
              members={candidates}
              refusalFor={refusalFor}
              onPick={(member) => change(member, true)}
            >
              <Button size="sm">
                <UserPlusIcon aria-hidden="true" />
                Add members
              </Button>
            </MemberPicker>
          </div>
        ) : null}
      </div>
      {shown.length === 0 ? (
        <EmptyState
          icon={UsersIcon}
          title={q ? 'No members match' : 'Nobody has this role yet'}
          description={
            q
              ? 'Try another name or username.'
              : canAddAny
                ? 'Add members to give them its permissions and color.'
                : undefined
          }
        />
      ) : (
        <ul className="divide-y rounded-lg border">
          {shown.map((member) => {
            const refusal = refusalFor(member);
            return (
              <li key={member.user.id} className="flex items-center gap-3 px-4 py-2.5">
                <UserAvatar user={member.user} size="lg" />
                <div className="min-w-0 flex-1">
                  <p
                    className="truncate text-sm font-medium"
                    style={
                      member.color
                        ? { color: readableTextColor(member.color, resolvedTheme) }
                        : undefined
                    }
                  >
                    {member.user.name}
                  </p>
                  <p className="truncate text-xs text-muted-foreground">@{member.user.username}</p>
                </div>
                {refusal === null ? (
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={`Remove ${role.name} from ${member.user.name}`}
                    title="Remove from role"
                    onClick={() => change(member, false)}
                  >
                    <XIcon aria-hidden="true" />
                  </Button>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function EditorSkeleton() {
  return (
    <div className="space-y-4" role="status" aria-label="Loading role">
      <Skeleton className="h-7 w-56" />
      <Skeleton className="h-9 w-72" />
      <Skeleton className="h-40 w-full" />
    </div>
  );
}
