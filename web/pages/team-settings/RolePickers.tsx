import { LockIcon } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import type { Member, Role } from '@shared/schemas/teams';
import { AgentBadge } from '@web/components/common/AgentBadge';
import { UserAvatar } from '@web/components/common/UserAvatar';
import { CheckBox, PickerShell } from '@web/components/pickers/PickerShell';
import { CommandGroup, CommandItem } from '@web/components/ui/command';
import { agentOwnerLabel, isAgentUser } from '@web/lib/agentMembers';
import { roleAssignRefusal, type Viewer } from '@web/pages/teams/access';
import type { ActorPermissions } from '@shared/permissions';

export interface MemberRolesPickerProps {
  /** Assignable roles (not `@everyone`), highest first. */
  roles: readonly Role[];
  member: Member;
  target: ActorPermissions;
  viewer: Viewer;
  onToggle: (role: Role, assigned: boolean) => void;
  /** The trigger button. */
  children: ReactNode;
}

/**
 * Grants and revokes a member's roles. Roles the viewer may not grant are listed but disabled,
 * with the reason underneath. The popover stays open while toggling.
 */
export function MemberRolesPicker({
  roles,
  member,
  target,
  viewer,
  onToggle,
  children,
}: MemberRolesPickerProps) {
  const [open, setOpen] = useState(false);
  const held = new Set(member.roles.map((role) => role.id));
  const subject = { ...target, userId: member.user.id };
  return (
    <PickerShell
      open={open}
      onOpenChange={setOpen}
      trigger={children}
      searchPlaceholder="Find a role…"
      emptyText={roles.length ? 'No roles found.' : 'This team has no roles yet.'}
      className="w-72"
      align="start"
    >
      <CommandGroup>
        {roles.map((role) => {
          const checked = held.has(role.id);
          const refusal = roleAssignRefusal(viewer, role, subject);
          return (
            <CommandItem
              key={role.id}
              value={role.id}
              keywords={[role.name]}
              disabled={refusal !== null}
              onSelect={() => onToggle(role, !checked)}
              className="items-start"
            >
              <CheckBox checked={checked} />
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-2">
                  <span
                    aria-hidden="true"
                    className="size-2.5 shrink-0 rounded-full"
                    style={{ backgroundColor: role.color ?? 'var(--muted-foreground)' }}
                  />
                  <span className="truncate">{role.name}</span>
                  {refusal ? <LockIcon className="ml-auto size-3.5" aria-hidden="true" /> : null}
                </span>
                {refusal ? (
                  <span className="mt-0.5 block text-xs text-muted-foreground">{refusal}</span>
                ) : null}
              </span>
            </CommandItem>
          );
        })}
      </CommandGroup>
    </PickerShell>
  );
}

export interface MemberPickerProps {
  /** Candidates (members who don't have the role yet). */
  members: readonly Member[];
  /** Why a candidate can't get the role, or null. */
  refusalFor: (member: Member) => string | null;
  onPick: (member: Member) => void;
  children: ReactNode;
}

/** Picks a member to give a role to (the role editor's Members tab). */
export function MemberPicker({ members, refusalFor, onPick, children }: MemberPickerProps) {
  const [open, setOpen] = useState(false);
  return (
    <PickerShell
      open={open}
      onOpenChange={setOpen}
      trigger={children}
      searchPlaceholder="Find a member…"
      emptyText={members.length ? 'No members found.' : 'Everyone already has this role.'}
      className="w-72"
      align="end"
    >
      <CommandGroup>
        {members.map((member) => {
          const refusal = refusalFor(member);
          return (
            <CommandItem
              key={member.user.id}
              value={member.user.id}
              keywords={[member.user.name, member.user.username]}
              disabled={refusal !== null}
              onSelect={() => {
                onPick(member);
                setOpen(false);
              }}
              className="items-start"
            >
              <UserAvatar user={member.user} size="md" />
              <span className="min-w-0 flex-1">
                <span className="flex min-w-0 items-center gap-1.5">
                  <span className="truncate">{member.user.name}</span>
                  {isAgentUser(member.user) ? <AgentBadge /> : null}
                </span>
                <span className="block truncate text-xs text-muted-foreground">
                  {refusal ??
                    (isAgentUser(member.user)
                      ? `@${member.user.username} · ${agentOwnerLabel(member.user)}`
                      : `@${member.user.username}`)}
                </span>
              </span>
            </CommandItem>
          );
        })}
      </CommandGroup>
    </PickerShell>
  );
}
