import { GlobeIcon, PlusIcon, ShieldIcon, UsersIcon, XIcon } from 'lucide-react';
import { useId, useState } from 'react';
import {
  PRINCIPAL_SCOPES,
  type Principal,
  type PrincipalRule,
  type PrincipalScope,
} from '@shared/principals';
import { UserAvatar } from '@web/components/common/UserAvatar';
import { Button } from '@web/components/ui/button';
import { CommandGroup, CommandItem } from '@web/components/ui/command';
import { cn } from '@web/lib/utils';
import { PickerShell } from './PickerShell';
import {
  EMPTY_RULE,
  isAgentUser,
  principalKey,
  principalLabel,
  samePrincipal,
  SCOPE_LABELS,
  type PrincipalOptions,
} from './principals';

/**
 * Edits a "who" rule (design §2): who is allowed (people, agents, team roles, project roles,
 * everyone; roles and everyone with a scope of people, agents or both) and who is excepted. The
 * rule matches anyone allowed who isn't excepted. Used for hand-offs, notify lists, move rules
 * and approvers.
 */

export interface PrincipalRulePickerProps {
  value: PrincipalRule | null;
  onChange: (rule: PrincipalRule) => void;
  options: PrincipalOptions;
  /** Accessible name of the whole rule, e.g. "Who can approve". */
  label: string;
  /** Offer the "Except" list (default true). */
  allowDeny?: boolean;
  disabled?: boolean;
  className?: string;
}

export function PrincipalRulePicker({
  value,
  onChange,
  options,
  label,
  allowDeny = true,
  disabled,
  className,
}: PrincipalRulePickerProps) {
  const rule = value ?? EMPTY_RULE;
  const labelId = useId();
  const set = (list: 'allow' | 'deny', principals: Principal[]) =>
    onChange({ ...rule, [list]: principals });
  return (
    <div role="group" aria-labelledby={labelId} className={cn('grid gap-2', className)}>
      <span id={labelId} className="sr-only">
        {label}
      </span>
      <PrincipalList
        heading="Allow"
        label={`${label}: allowed`}
        principals={rule.allow}
        options={options}
        disabled={disabled}
        onChange={(principals) => set('allow', principals)}
        emptyText="Nobody yet"
      />
      {allowDeny ? (
        <PrincipalList
          heading="Except"
          label={`${label}: excepted`}
          principals={rule.deny}
          options={options}
          disabled={disabled}
          onChange={(principals) => set('deny', principals)}
          emptyText="No exceptions"
        />
      ) : null}
    </div>
  );
}

function PrincipalList({
  heading,
  label,
  principals,
  options,
  disabled,
  onChange,
  emptyText,
}: {
  heading: string;
  label: string;
  principals: readonly Principal[];
  options: PrincipalOptions;
  disabled?: boolean;
  onChange: (principals: Principal[]) => void;
  emptyText: string;
}) {
  const [open, setOpen] = useState(false);
  const add = (principal: Principal) => {
    if (principals.some((existing) => samePrincipal(existing, principal))) return;
    onChange([...principals, principal]);
    setOpen(false);
  };
  const remove = (principal: Principal) =>
    onChange(principals.filter((existing) => !samePrincipal(existing, principal)));
  const setScope = (principal: Principal, scope: PrincipalScope) =>
    onChange(
      principals.map((existing) =>
        samePrincipal(existing, principal) && 'scope' in existing
          ? { ...existing, scope }
          : existing,
      ),
    );
  const has = (principal: Principal) => principals.some((p) => samePrincipal(p, principal));
  const people = options.users.filter((user) => !isAgentUser(user));
  const agents = options.users.filter((user) => isAgentUser(user));

  return (
    <div className="grid grid-cols-[4rem_minmax(0,1fr)] items-start gap-2">
      <span className="pt-1.5 text-xs font-medium text-muted-foreground">{heading}</span>
      <ul aria-label={label} className="flex min-w-0 flex-wrap items-center gap-1.5">
        {principals.length === 0 ? (
          <li className="py-1 text-sm text-muted-foreground">{emptyText}</li>
        ) : null}
        {principals.map((principal) => {
          const text = principalLabel(withoutScope(principal), options);
          return (
            <li
              key={principalKey(principal)}
              className="inline-flex max-w-full items-center gap-1 rounded-md border bg-muted/40 py-0.5 pr-0.5 pl-2 text-sm"
            >
              <PrincipalIcon principal={principal} />
              <span className="truncate">{text}</span>
              {'scope' in principal ? (
                <select
                  aria-label={`Scope of ${text}`}
                  value={principal.scope}
                  disabled={disabled}
                  onChange={(event) => setScope(principal, event.target.value as PrincipalScope)}
                  className="h-6 rounded border-none bg-transparent text-xs text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                >
                  {PRINCIPAL_SCOPES.map((scope) => (
                    <option key={scope} value={scope}>
                      {SCOPE_LABELS[scope]}
                    </option>
                  ))}
                </select>
              ) : null}
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                className="size-6"
                disabled={disabled}
                aria-label={`Remove ${text}`}
                onClick={() => remove(principal)}
              >
                <XIcon aria-hidden="true" />
              </Button>
            </li>
          );
        })}
        <li>
          <PickerShell
            open={open}
            onOpenChange={setOpen}
            searchPlaceholder={`Add to ${heading.toLowerCase()}…`}
            emptyText="No one matches."
            className="w-72"
            trigger={
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-7"
                disabled={disabled}
                aria-label={`Add to ${label}`}
              >
                <PlusIcon aria-hidden="true" />
                Add
              </Button>
            }
          >
            <CommandGroup heading="Everyone">
              <CommandItem
                value="everyone"
                keywords={['everyone', 'anyone', 'all']}
                disabled={has({ type: 'everyone', scope: 'both' })}
                onSelect={() => add({ type: 'everyone', scope: 'both' })}
              >
                <GlobeIcon aria-hidden="true" />
                Everyone in the team
              </CommandItem>
            </CommandGroup>
            {options.roles.length ? (
              <CommandGroup heading="Team roles">
                {options.roles.map((role) => (
                  <CommandItem
                    key={role.id}
                    value={`role.${role.id}`}
                    keywords={[role.isEveryone ? '@everyone' : role.name]}
                    disabled={has({ type: 'role', roleId: role.id, scope: 'both' })}
                    onSelect={() => add({ type: 'role', roleId: role.id, scope: 'both' })}
                  >
                    <RoleDot color={role.color} />
                    <span className="truncate">{role.isEveryone ? '@everyone' : role.name}</span>
                  </CommandItem>
                ))}
              </CommandGroup>
            ) : null}
            {options.projectRoles.length ? (
              <CommandGroup heading="Project roles">
                {options.projectRoles.map((role) => (
                  <CommandItem
                    key={role.id}
                    value={`project_role.${role.id}`}
                    keywords={[role.name]}
                    disabled={has({ type: 'project_role', roleId: role.id, scope: 'both' })}
                    onSelect={() => add({ type: 'project_role', roleId: role.id, scope: 'both' })}
                  >
                    <RoleDot color={role.color} />
                    <span className="truncate">{role.name}</span>
                  </CommandItem>
                ))}
              </CommandGroup>
            ) : null}
            {[
              { heading: 'People', users: people },
              { heading: 'Agents', users: agents },
            ].map((group) =>
              group.users.length ? (
                <CommandGroup key={group.heading} heading={group.heading}>
                  {group.users.map((user) => (
                    <CommandItem
                      key={user.id}
                      value={`user.${user.id}`}
                      keywords={[user.name, user.username]}
                      disabled={has({ type: 'user', userId: user.id })}
                      onSelect={() => add({ type: 'user', userId: user.id })}
                    >
                      <UserAvatar user={user} size="sm" />
                      <span className="truncate">{user.name}</span>
                      <span className="ml-auto truncate text-xs text-muted-foreground">
                        @{user.username}
                      </span>
                    </CommandItem>
                  ))}
                </CommandGroup>
              ) : null,
            )}
          </PickerShell>
        </li>
      </ul>
    </div>
  );
}

/** Chip text leaves the scope to the scope menu next to it. */
function withoutScope(principal: Principal): Principal {
  return 'scope' in principal ? { ...principal, scope: 'both' } : principal;
}

function PrincipalIcon({ principal }: { principal: Principal }) {
  const className = 'size-3.5 shrink-0 text-muted-foreground';
  switch (principal.type) {
    case 'everyone':
      return <GlobeIcon className={className} aria-hidden="true" />;
    case 'role':
      return <ShieldIcon className={className} aria-hidden="true" />;
    case 'project_role':
      return <UsersIcon className={className} aria-hidden="true" />;
    case 'user':
      return null;
  }
}

function RoleDot({ color }: { color: string | null }) {
  return (
    <span
      aria-hidden="true"
      className="size-2.5 shrink-0 rounded-full"
      style={{ backgroundColor: color ?? 'var(--muted-foreground)' }}
    />
  );
}
