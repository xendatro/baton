import { BotIcon, GlobeIcon, PlusIcon, ShieldIcon, UserIcon, XIcon } from 'lucide-react';
import { useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import type { Principal, PrincipalRule } from '@shared/principals';
import { cn } from '@web/lib/utils';
import {
  EMPTY_RULE,
  isAgentUser,
  principalKey,
  samePrincipal,
  type PrincipalOptions,
} from './principals';

/**
 * Edits a "who" rule (design §2) by typing `@`, Discord-style: `@ann` is a person, `@ann-ai` her
 * agent, `@developer` the people with the Developer role and `@developer-ai` their agents,
 * `@everyone` / `@everyone-ai` the whole team. Chips are colored by kind (roles in their own
 * color), and a name shared by a person and a role is told apart by the tag in the suggestions.
 * **Include** says who the rule matches; **Exclude** (behind a link until used) carves people out.
 * Used for hand-offs, move rules and approvers.
 */

export interface PrincipalRulePickerProps {
  value: PrincipalRule | null;
  onChange: (rule: PrincipalRule) => void;
  options: PrincipalOptions;
  /** Accessible name of the whole rule, e.g. "Who can approve". */
  label: string;
  /** Offer the "Exclude" list (default true). */
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
  const [showExclude, setShowExclude] = useState(false);
  const set = (list: 'allow' | 'deny', principals: Principal[]) =>
    onChange({ ...rule, [list]: principals });
  const excluding = allowDeny && (showExclude || rule.deny.length > 0);
  return (
    <div role="group" aria-label={label} className={cn('grid gap-2', className)}>
      <MentionList
        heading="Include"
        label={`${label}: include`}
        principals={rule.allow}
        options={options}
        disabled={disabled}
        onChange={(principals) => set('allow', principals)}
      />
      {excluding ? (
        <MentionList
          heading="Exclude"
          label={`${label}: exclude`}
          principals={rule.deny}
          options={options}
          disabled={disabled}
          autoFocus={showExclude && rule.deny.length === 0}
          onChange={(principals) => set('deny', principals)}
        />
      ) : allowDeny && !disabled ? (
        <button
          type="button"
          onClick={() => setShowExclude(true)}
          className="justify-self-start rounded text-xs text-muted-foreground outline-none hover:text-foreground hover:underline focus-visible:ring-2 focus-visible:ring-ring"
        >
          <PlusIcon className="mr-0.5 inline size-3" aria-hidden="true" />
          Exclude someone
        </button>
      ) : null}
    </div>
  );
}

type MentionKind = 'person' | 'agent' | 'role' | 'role-agents' | 'everyone' | 'everyone-agents';

interface Mention {
  principal: Principal;
  /** `@developer-ai`. */
  handle: string;
  /** What it is, in words: "People with the Developer role". */
  description: string;
  /** Short tag in the suggestions: "Person", "Role", "Project role"… */
  tag: string;
  kind: MentionKind;
  color: string | null;
}

/** `Front End` → `front-end`. */
function slug(name: string): string {
  return (
    name
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'role'
  );
}

/** Everything `@` can name, in the order suggestions list it. */
function buildMentions(options: PrincipalOptions): Mention[] {
  const mentions: Mention[] = [
    {
      principal: { type: 'everyone', scope: 'people' },
      handle: '@everyone',
      description: 'Every person in the team',
      tag: 'Everyone',
      kind: 'everyone',
      color: null,
    },
    {
      principal: { type: 'everyone', scope: 'agents' },
      handle: '@everyone-ai',
      description: 'Every agent in the team',
      tag: 'Everyone',
      kind: 'everyone-agents',
      color: null,
    },
  ];
  const roles = [
    ...options.roles
      .filter((role) => !role.isEveryone)
      .map((role) => ({ ...role, type: 'role' as const, tag: 'Role' })),
    ...options.projectRoles.map((role) => ({
      ...role,
      type: 'project_role' as const,
      tag: 'Project role',
    })),
  ];
  for (const role of roles) {
    const handle = `@${slug(role.name)}`;
    mentions.push(
      {
        principal: { type: role.type, roleId: role.id, scope: 'people' },
        handle,
        description: `People with the ${role.name} role`,
        tag: role.tag,
        kind: 'role',
        color: role.color,
      },
      {
        principal: { type: role.type, roleId: role.id, scope: 'agents' },
        handle: `${handle}-ai`,
        description: `Agents of people with the ${role.name} role`,
        tag: `${role.tag} · agents`,
        kind: 'role-agents',
        color: role.color,
      },
    );
  }
  for (const user of options.users) {
    const agent = isAgentUser(user);
    mentions.push({
      principal: { type: 'user', userId: user.id },
      handle: `@${user.username}`,
      description: user.name,
      tag: agent ? 'Agent' : 'Person',
      kind: agent ? 'agent' : 'person',
      color: null,
    });
  }
  return mentions;
}

/** The chip of a principal already in the rule (also older `both`-scoped roles). */
function mentionOf(principal: Principal, mentions: readonly Mention[]): Mention {
  if ('scope' in principal && principal.scope === 'both') {
    const people = mentions.find(
      (mention) =>
        samePrincipal(mention.principal, principal) &&
        'scope' in mention.principal &&
        mention.principal.scope === 'people',
    );
    if (people) {
      return {
        ...people,
        principal,
        handle: `${people.handle} + agents`,
        description: `${people.description}, and their agents`,
      };
    }
  }
  const found = mentions.find(
    (mention) =>
      samePrincipal(mention.principal, principal) &&
      (!('scope' in principal) ||
        ('scope' in mention.principal && mention.principal.scope === principal.scope)),
  );
  return (
    found ?? {
      principal,
      handle: principal.type === 'user' ? 'a former member' : 'a deleted role',
      description: '',
      tag: '',
      kind: principal.type === 'user' ? 'person' : 'role',
      color: null,
    }
  );
}

function sameEntry(a: Principal, b: Principal): boolean {
  return (
    principalKey(a) === principalKey(b) &&
    ('scope' in a ? a.scope : '') === ('scope' in b ? b.scope : '')
  );
}

function matches(mention: Mention, query: string): number {
  const q = query.replace(/^@/, '').toLowerCase();
  if (!q) return 1;
  const handle = mention.handle.slice(1).toLowerCase();
  if (handle.startsWith(q)) return 3;
  if (mention.description.toLowerCase().includes(q)) return 2;
  if (handle.includes(q)) return 1;
  return 0;
}

const KIND_ICONS = {
  person: UserIcon,
  agent: BotIcon,
  role: ShieldIcon,
  'role-agents': BotIcon,
  everyone: GlobeIcon,
  'everyone-agents': BotIcon,
} as const;

function chipStyle(mention: Mention) {
  if (mention.color && (mention.kind === 'role' || mention.kind === 'role-agents')) {
    return {
      backgroundColor: `${mention.color}1f`,
      color: mention.color,
      borderColor: `${mention.color}55`,
    };
  }
  return undefined;
}

function chipClass(mention: Mention): string {
  switch (mention.kind) {
    case 'agent':
    case 'everyone-agents':
      return 'border-violet-500/30 bg-violet-500/10 text-violet-700 dark:text-violet-300';
    case 'role':
    case 'role-agents':
      return mention.color ? '' : 'border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-300';
    case 'everyone':
      return 'border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300';
    case 'person':
      return 'bg-muted/60';
  }
}

function MentionList({
  heading,
  label,
  principals,
  options,
  disabled,
  autoFocus,
  onChange,
}: {
  heading: string;
  label: string;
  principals: readonly Principal[];
  options: PrincipalOptions;
  disabled?: boolean;
  autoFocus?: boolean;
  onChange: (principals: Principal[]) => void;
}) {
  const id = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const mentions = useMemo(() => buildMentions(options), [options]);
  const suggestions = useMemo(
    () =>
      mentions
        .map((mention) => ({ mention, score: matches(mention, query) }))
        .filter(
          ({ mention, score }) =>
            score > 0 && !principals.some((existing) => sameEntry(existing, mention.principal)),
        )
        .sort((a, b) => b.score - a.score)
        .slice(0, 8)
        .map(({ mention }) => mention),
    [mentions, query, principals],
  );
  const listboxId = `${id}-listbox`;
  const showList = open && !disabled;

  const add = (mention: Mention) => {
    onChange([...principals, mention.principal]);
    setQuery('');
    setActive(0);
    inputRef.current?.focus();
  };
  const remove = (principal: Principal) =>
    onChange(principals.filter((existing) => !sameEntry(existing, principal)));

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setOpen(true);
      setActive((index) => Math.min(index + 1, Math.max(suggestions.length - 1, 0)));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActive((index) => Math.max(index - 1, 0));
    } else if (event.key === 'Enter') {
      const pick = suggestions[active];
      if (showList && pick) {
        event.preventDefault();
        add(pick);
      }
    } else if (event.key === 'Escape') {
      if (showList) {
        event.preventDefault();
        event.stopPropagation();
        setOpen(false);
      }
    } else if (event.key === 'Backspace' && query === '' && principals.length > 0) {
      const last = principals[principals.length - 1];
      if (last) remove(last);
    }
  };

  return (
    <div className="grid grid-cols-[4.25rem_minmax(0,1fr)] items-start gap-2">
      <span className="pt-2 text-xs font-medium text-muted-foreground">{heading}</span>
      <div className="relative min-w-0">
        <div
          className={cn(
            'flex min-h-9 flex-wrap items-center gap-1 rounded-md border border-input bg-transparent px-1.5 py-1 shadow-xs focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/50 dark:bg-input/30',
            disabled && 'opacity-60',
          )}
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) {
              event.preventDefault();
              inputRef.current?.focus();
            }
          }}
        >
          <ul aria-label={label} className="contents">
            {principals.map((principal) => {
              const mention = mentionOf(principal, mentions);
              const Icon = KIND_ICONS[mention.kind];
              return (
                <li
                  key={`${principalKey(principal)}:${'scope' in principal ? principal.scope : ''}`}
                  title={mention.description || undefined}
                  className={cn(
                    'inline-flex max-w-full items-center gap-1 rounded border py-0.5 pr-0.5 pl-1.5 text-xs font-medium',
                    chipClass(mention),
                  )}
                  style={chipStyle(mention)}
                >
                  <Icon className="size-3 shrink-0" aria-hidden="true" />
                  <span className="truncate">{mention.handle}</span>
                  <button
                    type="button"
                    disabled={disabled}
                    aria-label={`Remove ${mention.handle}`}
                    onClick={() => remove(principal)}
                    className="flex size-4 items-center justify-center rounded opacity-70 outline-none hover:opacity-100 focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <XIcon className="size-3" aria-hidden="true" />
                  </button>
                </li>
              );
            })}
          </ul>
          <input
            ref={inputRef}
            role="combobox"
            aria-label={`Add to ${label}`}
            aria-expanded={showList}
            aria-controls={listboxId}
            aria-autocomplete="list"
            aria-activedescendant={
              showList && suggestions[active] ? `${id}-option-${active}` : undefined
            }
            value={query}
            disabled={disabled}
            autoFocus={autoFocus}
            onChange={(event) => {
              setQuery(event.target.value);
              setActive(0);
              setOpen(true);
            }}
            onFocus={() => setOpen(true)}
            onBlur={() => setOpen(false)}
            onKeyDown={onKeyDown}
            placeholder={principals.length === 0 ? 'Type @ to add people, agents or roles' : ''}
            className="h-6 min-w-24 flex-1 bg-transparent px-1 text-sm outline-none placeholder:text-muted-foreground"
            autoComplete="off"
          />
        </div>
        {showList ? (
          <ul
            id={listboxId}
            role="listbox"
            aria-label={`Suggestions for ${label}`}
            className="absolute inset-x-0 top-full z-50 mt-1 max-h-64 overflow-y-auto rounded-md border bg-popover p-1 text-popover-foreground shadow-md"
          >
            {suggestions.length === 0 ? (
              <li className="px-2 py-1.5 text-sm text-muted-foreground">No one matches.</li>
            ) : (
              suggestions.map((mention, index) => {
                const Icon = KIND_ICONS[mention.kind];
                return (
                  <li
                    key={`${principalKey(mention.principal)}:${mention.handle}`}
                    id={`${id}-option-${index}`}
                    role="option"
                    aria-selected={index === active}
                    onMouseDown={(event) => event.preventDefault()}
                    onMouseEnter={() => setActive(index)}
                    onClick={() => add(mention)}
                    className={cn(
                      'flex cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 text-sm',
                      index === active && 'bg-accent text-accent-foreground',
                    )}
                  >
                    <span
                      className={cn(
                        'inline-flex shrink-0 items-center gap-1 rounded border px-1.5 py-0.5 text-xs font-medium',
                        chipClass(mention),
                      )}
                      style={chipStyle(mention)}
                    >
                      <Icon className="size-3" aria-hidden="true" />
                      {mention.handle}
                    </span>
                    <span className="min-w-0 truncate text-muted-foreground">
                      {mention.description}
                    </span>
                    <span className="ml-auto shrink-0 text-[0.7rem] tracking-wide text-muted-foreground uppercase">
                      {mention.tag}
                    </span>
                  </li>
                );
              })
            )}
          </ul>
        ) : null}
      </div>
    </div>
  );
}
