import { UserPlusIcon, UsersIcon } from 'lucide-react';
import type { RoleSummary, UserSummary } from '@shared/schemas/core';
import { AvatarStack, UserAvatar } from '@web/components/common/UserAvatar';
import { Button } from '@web/components/ui/button';
import { CommandGroup, CommandItem } from '@web/components/ui/command';
import { CheckBox, PickerShell, type PickerControlProps } from './PickerShell';
import { useOpenState } from './useOpenState';

export interface AssigneeValue {
  userIds: string[];
  roleIds: string[];
}

export interface AssigneePickerProps extends PickerControlProps {
  users: readonly UserSummary[];
  roles: readonly RoleSummary[];
  value: AssigneeValue;
  onChange: (value: AssigneeValue) => void;
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
    >
      {sortedUsers.length ? (
        <CommandGroup heading="People">
          {sortedUsers.map((user) => {
            const checked = value.userIds.includes(user.id);
            return (
              <CommandItem
                key={user.id}
                value={`user ${user.name} ${user.username} ${user.id}`}
                onSelect={() => onChange({ ...value, userIds: toggle(value.userIds, user.id) })}
              >
                <CheckBox checked={checked} />
                <UserAvatar user={user} size="sm" />
                <span className="truncate">
                  {user.name}
                  {user.id === currentUserId ? (
                    <span className="text-muted-foreground"> (you)</span>
                  ) : null}
                </span>
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
                value={`role ${role.name} ${role.slug} ${role.id}`}
                onSelect={() => onChange({ ...value, roleIds: toggle(value.roleIds, role.id) })}
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
