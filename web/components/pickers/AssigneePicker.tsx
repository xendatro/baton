import { UserPlusIcon, UsersIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import type { RoleSummary, UserSummary } from '@shared/schemas/core';
import { AgentBadge } from '@web/components/common/AgentBadge';
import { AvatarStack, UserAvatar } from '@web/components/common/UserAvatar';
import { Button } from '@web/components/ui/button';
import { CommandGroup, CommandItem } from '@web/components/ui/command';
import { isAgentUser } from '@web/lib/agentMembers';
import { CheckBox, PickerShell, type PickerControlProps } from './PickerShell';
import { useOpenState } from './useOpenState';

export interface AssigneeValue {
  userIds: string[];
  roleIds: string[];
}

/** One person or role added (`add`) or removed, as a single change applied right away. */
export type AssigneeToggle =
  | { kind: 'user'; assignee: UserSummary; add: boolean }
  | { kind: 'role'; assignee: RoleSummary; add: boolean };

export interface AssigneePickerProps extends PickerControlProps {
  users: readonly UserSummary[];
  roles: readonly RoleSummary[];
  value: AssigneeValue;
  /** The whole selection after a toggle (forms that save later). */
  onChange?: (value: AssigneeValue) => void;
  /**
   * Each toggle on its own, instead of `onChange` (pages that apply it at once: the task page adds
   * or removes that one assignee, keeping any others added meanwhile).
   */
  onToggle?: (toggle: AssigneeToggle) => void;
  /** Shown under the list, e.g. which stage the assignments belong to. */
  note?: ReactNode;
  /** Listed first and marked "(you)". */
  currentUserId?: string;
}

function toggle(list: readonly string[], id: string): string[] {
  return list.includes(id) ? list.filter((item) => item !== id) : [...list, id];
}

/** Multi-select of people and roles (assignment is a suggestion, not a lock). */
export function AssigneePicker({
  users,
  roles,
  value,
  onChange,
  onToggle,
  note,
  currentUserId,
  open,
  onOpenChange,
  disabled,
  children,
  align,
}: AssigneePickerProps) {
  const [isOpen, setOpen] = useOpenState(open, onOpenChange);
  const sortedUsers = [...users].sort((a, b) =>
    a.id === currentUserId ? -1 : b.id === currentUserId ? 1 : a.name.localeCompare(b.name),
  );
  const selectedUsers = users.filter((user) => value.userIds.includes(user.id));
  const selectedRoles = roles.filter((role) => value.roleIds.includes(role.id));
  const count = selectedUsers.length + selectedRoles.length;

  const trigger = children ?? (
    <Button
      variant="outline"
      size="sm"
      disabled={disabled}
      aria-label={
        count
          ? `Assignees: ${[...selectedUsers.map((u) => u.name), ...selectedRoles.map((r) => r.name)].join(', ')}`
          : 'Assign'
      }
    >
      {selectedUsers.length ? <AvatarStack users={selectedUsers} size="sm" /> : null}
      {selectedRoles.length ? (
        <span className="inline-flex items-center gap-1 text-xs">
          <UsersIcon className="size-3.5" aria-hidden="true" />
          {selectedRoles.map((role) => role.name).join(', ')}
        </span>
      ) : null}
      {count === 0 ? (
        <>
          <UserPlusIcon aria-hidden="true" />
          Assign
        </>
      ) : null}
    </Button>
  );

  return (
    <PickerShell
      open={isOpen}
      onOpenChange={setOpen}
      trigger={trigger}
      searchPlaceholder="Assign to…"
      emptyText="No one matches."
      align={align}
      className="w-72"
      footer={note ? <p className="px-2 py-1 text-xs text-muted-foreground">{note}</p> : undefined}
    >
      {sortedUsers.length ? (
        <CommandGroup heading="People">
          {sortedUsers.map((user) => {
            const checked = value.userIds.includes(user.id);
            return (
              <CommandItem
                key={user.id}
                value={`user.${user.id}`}
                keywords={[user.name, user.username]}
                onSelect={() =>
                  onToggle
                    ? onToggle({ kind: 'user', assignee: user, add: !checked })
                    : onChange?.({ ...value, userIds: toggle(value.userIds, user.id) })
                }
              >
                <CheckBox checked={checked} />
                <UserAvatar user={user} size="sm" />
                <span className="truncate">
                  {user.name}
                  {user.id === currentUserId ? (
                    <span className="text-muted-foreground"> (you)</span>
                  ) : null}
                </span>
                {isAgentUser(user) ? <AgentBadge /> : null}
                <span className="ml-auto truncate text-xs text-muted-foreground">
                  @{user.username}
                </span>
              </CommandItem>
            );
          })}
        </CommandGroup>
      ) : null}
      {roles.length ? (
        <CommandGroup heading="Roles">
          {roles.map((role) => {
            const checked = value.roleIds.includes(role.id);
            return (
              <CommandItem
                key={role.id}
                value={`role.${role.id}`}
                keywords={[role.name, role.slug]}
                onSelect={() =>
                  onToggle
                    ? onToggle({ kind: 'role', assignee: role, add: !checked })
                    : onChange?.({ ...value, roleIds: toggle(value.roleIds, role.id) })
                }
              >
                <CheckBox checked={checked} />
                <span
                  aria-hidden="true"
                  className="size-2.5 shrink-0 rounded-full"
                  style={{ backgroundColor: role.color ?? 'var(--muted-foreground)' }}
                />
                <span className="truncate">{role.name}</span>
              </CommandItem>
            );
          })}
        </CommandGroup>
      ) : null}
    </PickerShell>
  );
}
