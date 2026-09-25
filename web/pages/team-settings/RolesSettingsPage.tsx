import {
  closestCenter,
  DndContext,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type Announcements,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import {
  AtSignIcon,
  ChevronRightIcon,
  GripVerticalIcon,
  LockIcon,
  PlusIcon,
  ShieldIcon,
  UsersIcon,
} from 'lucide-react';
import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import type { MeTeam } from '@shared/schemas/core';
import type { Role } from '@shared/schemas/teams';
import { EmptyState } from '@web/components/common/EmptyState';
import { ErrorState } from '@web/components/common/ErrorState';
import { Badge } from '@web/components/ui/badge';
import { Button } from '@web/components/ui/button';
import { Skeleton } from '@web/components/ui/skeleton';
import { Tooltip, TooltipContent, TooltipTrigger } from '@web/components/ui/tooltip';
import { pluralize } from '@web/lib/format';
import { useDocumentTitle } from '@web/lib/title';
import { cn } from '@web/lib/utils';
import { reorderWithPinned, roleManageRefusal } from '@web/pages/teams/access';
import { useReorderRoles, useRoles } from '@web/pages/teams/api';
import { useSettingsTeam } from './context';
import { CreateRoleDialog } from './CreateRoleDialog';
import { SettingsHeader } from './SettingsSection';

/** Roles: the ordered role list (drag to reorder), `@everyone`, and "Create role". */
export default function RolesSettingsPage() {
  const team = useSettingsTeam();
  const navigate = useNavigate();
  const roles = useRoles(team.id);
  const [createOpen, setCreateOpen] = useState(false);
  const canManage = team.permissions.includes('MANAGE_ROLES');
  useDocumentTitle(['Roles', team.name]);

  const custom = roles.data?.items.filter((role) => !role.isEveryone) ?? [];
  const everyone = roles.data?.items.find((role) => role.isEveryone);

  return (
    <div>
      <SettingsHeader
        title="Roles"
        description="Members get the permissions of all their roles plus @everyone. Their name shows in the color of their highest colored role."
        actions={
          canManage ? (
            <Button size="sm" onClick={() => setCreateOpen(true)}>
              <PlusIcon aria-hidden="true" />
              Create role
            </Button>
          ) : null
        }
      />
      {roles.isPending ? (
        <RolesSkeleton />
      ) : roles.isError ? (
        <ErrorState
          title="Couldn’t load roles"
          error={roles.error}
          onRetry={() => void roles.refetch()}
        />
      ) : (
        <div className="space-y-6">
          {custom.length === 0 ? (
            <EmptyState
              icon={ShieldIcon}
              title="No roles yet"
              description="Roles group permissions, give members a name color and can be @mentioned or assigned to tasks."
              action={
                canManage ? (
                  <Button onClick={() => setCreateOpen(true)}>
                    <PlusIcon aria-hidden="true" />
                    Create role
                  </Button>
                ) : null
              }
            />
          ) : (
            <RoleList team={team} roles={custom} />
          )}
          {everyone ? <EveryoneCard team={team} role={everyone} /> : null}
        </div>
      )}
      <CreateRoleDialog
        team={team}
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreated={(role) => void navigate(`/t/${team.slug}/settings/roles/${role.id}`)}
      />
    </div>
  );
}

function RoleList({ team, roles }: { team: MeTeam; roles: Role[] }) {
  const reorder = useReorderRoles(team.id);
  const viewer = { isOwner: team.isOwner, permissions: team.permissions };
  const canReorder = team.permissions.includes('MANAGE_ROLES') && roles.length > 1;
  const movable = (id: string) => {
    const role = roles.find((candidate) => candidate.id === id);
    return canReorder && role !== undefined && roleManageRefusal(viewer, role.permissions) === null;
  };
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const ids = roles.map((role) => role.id);
  const nameOf = (id: string | number) => roles.find((role) => role.id === id)?.name ?? 'the role';
  const positionOf = (id: string | number) => ids.indexOf(String(id)) + 1;
  const announcements: Announcements = {
    onDragStart: ({ active }) =>
      `Picked up ${nameOf(active.id)}, position ${positionOf(active.id)} of ${ids.length}.`,
    onDragOver: ({ active, over }) =>
      over
        ? `${nameOf(active.id)} is over position ${positionOf(over.id)} of ${ids.length}.`
        : `${nameOf(active.id)} is no longer over a position.`,
    onDragEnd: ({ active, over }) =>
      over
        ? `Dropped ${nameOf(active.id)} at position ${positionOf(over.id)} of ${ids.length}.`
        : `Dropped ${nameOf(active.id)}.`,
    onDragCancel: ({ active }) => `Cancelled moving ${nameOf(active.id)}.`,
  };

  const onDragEnd = ({ active, over }: DragEndEvent) => {
    if (!over) return;
    const next = reorderWithPinned(ids, movable, String(active.id), String(over.id));
    if (!next) return;
    reorder.mutate(next);
  };

  return (
    <div className="rounded-lg border">
      <div className="flex items-center justify-between gap-2 border-b bg-muted/40 px-4 py-2 text-xs text-muted-foreground">
        <span>
          {pluralize(roles.length, 'role')}
          {canReorder ? ' · drag to reorder, highest first' : ' · highest first'}
        </span>
        <span className="hidden sm:inline">Members</span>
      </div>
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragEnd={onDragEnd}
        accessibility={{
          announcements,
          screenReaderInstructions: {
            draggable:
              'To reorder, press space or enter to pick up the role, use the arrow keys to move it, then press space or enter to drop it, or escape to cancel.',
          },
        }}
      >
        <SortableContext items={ids} strategy={verticalListSortingStrategy}>
          <ul className="divide-y">
            {roles.map((role) => (
              <SortableRoleRow
                key={role.id}
                team={team}
                role={role}
                draggable={movable(role.id)}
                showHandle={canReorder}
              />
            ))}
          </ul>
        </SortableContext>
      </DndContext>
    </div>
  );
}

function SortableRoleRow({
  team,
  role,
  draggable,
  showHandle,
}: {
  team: MeTeam;
  role: Role;
  draggable: boolean;
  showHandle: boolean;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: role.id, disabled: !draggable });
  const isAdmin = role.permissions.includes('ADMINISTRATOR');

  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      className={cn(
        'relative flex items-center gap-3 bg-card px-3 py-2.5 first:rounded-t-lg last:rounded-b-lg hover:bg-accent/40',
        isDragging && 'z-10 shadow-md ring-1 ring-border',
      )}
    >
      {showHandle ? (
        draggable ? (
          <button
            type="button"
            ref={setActivatorNodeRef}
            {...attributes}
            {...listeners}
            aria-label={`Reorder ${role.name}`}
            className="relative z-10 -my-1 flex size-7 cursor-grab touch-none items-center justify-center rounded-md text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 active:cursor-grabbing"
          >
            <GripVerticalIcon className="size-4" aria-hidden="true" />
          </button>
        ) : (
          <Tooltip>
            <TooltipTrigger asChild>
              <span
                tabIndex={0}
                className="relative z-10 flex size-7 items-center justify-center rounded-md text-muted-foreground/60 outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
                aria-label={`${role.name} can’t be moved by you`}
              >
                <LockIcon className="size-3.5" aria-hidden="true" />
              </span>
            </TooltipTrigger>
            <TooltipContent>
              {isAdmin
                ? 'Only administrators can move roles with Administrator'
                : 'This role has permissions you don’t have'}
            </TooltipContent>
          </Tooltip>
        )
      ) : null}
      <span
        aria-hidden="true"
        className="size-3 shrink-0 rounded-full border"
        style={{ backgroundColor: role.color ?? 'transparent' }}
      />
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1">
        <Link
          to={`/t/${team.slug}/settings/roles/${role.id}`}
          className="truncate text-sm font-medium outline-none after:absolute after:inset-0 after:rounded-[inherit] focus-visible:after:ring-[3px] focus-visible:after:ring-ring/50"
          style={role.color ? { color: role.color } : undefined}
        >
          {role.name}
        </Link>
        {isAdmin ? (
          <Badge variant="outline" className="text-[0.65rem]">
            Administrator
          </Badge>
        ) : null}
        {role.mentionable ? (
          <span title="Anyone can @mention this role" className="text-muted-foreground">
            <AtSignIcon className="size-3.5" aria-label="Mentionable" />
          </span>
        ) : null}
      </div>
      <span
        className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground"
        title={pluralize(role.memberCount, 'member')}
      >
        <UsersIcon className="size-3.5" aria-hidden="true" />
        {role.memberCount}
        <span className="sr-only">{role.memberCount === 1 ? 'member' : 'members'}</span>
      </span>
      <ChevronRightIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
    </li>
  );
}

function EveryoneCard({ team, role }: { team: MeTeam; role: Role }) {
  return (
    <div className="relative flex items-center gap-3 rounded-lg border bg-card px-4 py-3 hover:bg-accent/40">
      <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
        <UsersIcon className="size-4" aria-hidden="true" />
      </span>
      <div className="min-w-0 flex-1">
        <Link
          to={`/t/${team.slug}/settings/roles/${role.id}`}
          className="text-sm font-medium outline-none after:absolute after:inset-0 after:rounded-lg focus-visible:after:ring-[3px] focus-visible:after:ring-ring/50"
        >
          @everyone
        </Link>
        <p className="text-xs text-muted-foreground">
          Default permissions for all {pluralize(role.memberCount, 'member')} ·{' '}
          {pluralize(role.permissions.length, 'permission')}
        </p>
      </div>
      <ChevronRightIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
    </div>
  );
}

function RolesSkeleton() {
  return (
    <div className="divide-y rounded-lg border" role="status" aria-label="Loading roles">
      {[0, 1, 2].map((index) => (
        <div key={index} className="flex items-center gap-3 px-4 py-3">
          <Skeleton className="size-3 rounded-full" />
          <Skeleton className="h-4 w-40" />
          <Skeleton className="ml-auto h-4 w-8" />
        </div>
      ))}
    </div>
  );
}
