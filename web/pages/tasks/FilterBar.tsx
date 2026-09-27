import {
  BanIcon,
  CalendarIcon,
  ChevronDownIcon,
  CircleDashedIcon,
  CircleIcon,
  HandIcon,
  SearchIcon,
  SignalHighIcon,
  TagIcon,
  UserIcon,
  UserXIcon,
  UsersIcon,
  XIcon,
  type LucideIcon,
} from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { PRIORITIES } from '@shared/constants';
import type { RoleSummary, UserSummary } from '@shared/schemas/core';
import type { Label, Status } from '@shared/schemas/projects';
import { PriorityIcon } from '@web/components/common/PriorityIcon';
import { StatusIcon } from '@web/components/common/StatusBadge';
import { UserAvatar } from '@web/components/common/UserAvatar';
import { Kbd } from '@web/components/common/Kbd';
import { CheckBox } from '@web/components/pickers/PickerShell';
import { Button } from '@web/components/ui/button';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from '@web/components/ui/command';
import { Input } from '@web/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@web/components/ui/popover';
import { isAgentUser } from '@web/lib/agentMembers';
import { commandFilter } from '@web/lib/commandFilter';
import { useDebouncedValue } from '@web/lib/useDebouncedValue';
import { cn } from '@web/lib/utils';
import { activeFilterCount, EMPTY_FILTERS, type TaskFilterState } from './filters';

/**
 * The filter bar of the board and list (SPEC §1.9): text, status, assignee, label, priority,
 * due date, claim and blocked filters, all kept in the URL. `/` focuses the search box.
 */

export const FILTER_SEARCH_ID = 'task-filter-search';

interface Option {
  value: string;
  label: string;
  leading?: ReactNode;
  keywords?: string[];
  group?: string;
}

interface FilterPopoverProps {
  label: string;
  icon: LucideIcon;
  options: readonly Option[];
  values: readonly string[];
  onChange: (values: string[]) => void;
  /** One value at a time (the popover closes on choice). */
  single?: boolean;
  searchable?: boolean;
}

function FilterPopover({
  label,
  icon: Icon,
  options,
  values,
  onChange,
  single = false,
  searchable = true,
}: FilterPopoverProps) {
  const [open, setOpen] = useState(false);
  const chosen = options.filter((option) => values.includes(option.value));
  const groups = new Map<string, Option[]>();
  for (const option of options) {
    const group = option.group ?? '';
    groups.set(group, [...(groups.get(group) ?? []), option]);
  }
  const summary =
    chosen.length === 0
      ? null
      : chosen.length <= 2
        ? chosen.map((option) => option.label).join(', ')
        : `${chosen.length} selected`;

  const toggle = (value: string) => {
    if (single) {
      onChange(values.includes(value) ? [] : [value]);
      setOpen(false);
      return;
    }
    onChange(values.includes(value) ? values.filter((item) => item !== value) : [...values, value]);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className={cn(
            'max-w-64 min-w-0 shrink-0 justify-start',
            summary && 'border-primary/40 bg-primary/5 dark:bg-primary/10',
          )}
          aria-label={summary ? `${label}: ${summary}` : `Filter by ${label.toLowerCase()}`}
        >
          <Icon aria-hidden="true" className="text-muted-foreground" />
          {summary ? (
            <span className="min-w-0 truncate">
              <span className="text-muted-foreground">{label}: </span>
              {summary}
            </span>
          ) : (
            <span className="text-muted-foreground">{label}</span>
          )}
          <ChevronDownIcon aria-hidden="true" className="text-muted-foreground" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        className="w-64 max-w-[calc(100vw-2rem)] p-0"
        align="start"
        collisionPadding={16}
      >
        <Command filter={commandFilter}>
          {searchable ? (
            <CommandInput
              placeholder={`Filter by ${label.toLowerCase()}…`}
              aria-label={`Filter by ${label.toLowerCase()}`}
            />
          ) : null}
          <CommandList>
            <CommandEmpty>No matches.</CommandEmpty>
            {[...groups.entries()].map(([group, items], index) => (
              <div key={group || index}>
                {index > 0 ? <CommandSeparator /> : null}
                <CommandGroup heading={group || undefined}>
                  {items.map((option) => {
                    const checked = values.includes(option.value);
                    return (
                      <CommandItem
                        key={option.value}
                        value={option.value}
                        keywords={[option.label, ...(option.keywords ?? [])]}
                        onSelect={() => toggle(option.value)}
                      >
                        {single ? null : <CheckBox checked={checked} />}
                        {option.leading}
                        <span className="truncate">{option.label}</span>
                        {single && checked ? (
                          <span className="ml-auto text-xs text-muted-foreground">selected</span>
                        ) : null}
                      </CommandItem>
                    );
                  })}
                </CommandGroup>
              </div>
            ))}
            {values.length > 0 ? (
              <>
                <CommandSeparator />
                <CommandGroup>
                  <CommandItem
                    value="__clear__"
                    keywords={['clear', 'any', 'reset']}
                    onSelect={() => {
                      onChange([]);
                      setOpen(false);
                    }}
                  >
                    <XIcon aria-hidden="true" />
                    Clear {label.toLowerCase()} filter
                  </CommandItem>
                </CommandGroup>
              </>
            ) : null}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

function Dot({ color }: { color: string | null }) {
  return (
    <span
      aria-hidden="true"
      className="size-2.5 shrink-0 rounded-full"
      style={{ backgroundColor: color ?? 'var(--muted-foreground)' }}
    />
  );
}

export interface FilterBarProps {
  filters: TaskFilterState;
  onChange: (update: (current: TaskFilterState) => TaskFilterState) => void;
  statuses: readonly Status[];
  labels: readonly Label[];
  users: readonly UserSummary[];
  roles: readonly RoleSummary[];
  currentUserId: string | null;
  /** Right-aligned controls next to the search box (view toggle, New task). */
  actions?: ReactNode;
  /** Controls after the filters (the list's grouping). */
  extra?: ReactNode;
}

export function FilterBar({
  filters,
  onChange,
  statuses,
  labels,
  users,
  roles,
  currentUserId,
  actions,
  extra,
}: FilterBarProps) {
  const [text, setText] = useState(filters.q);
  const debounced = useDebouncedValue(text, 250);
  const lastSent = useRef(filters.q);
  // Typing updates the URL, debounced.
  useEffect(() => {
    if (debounced === lastSent.current) return;
    lastSent.current = debounced;
    onChange((current) => ({ ...current, q: debounced }));
  }, [debounced, onChange]);
  const set =
    <K extends keyof TaskFilterState>(key: K) =>
    (value: TaskFilterState[K]) =>
      onChange((current) => ({ ...current, [key]: value }));
  const single =
    <K extends 'due' | 'claimed' | 'blocked'>(key: K) =>
    (values: string[]) =>
      onChange((current) => ({ ...current, [key]: (values[0] ?? null) as TaskFilterState[K] }));

  const people: Option[] = [
    {
      value: 'me',
      label: 'Me (and my roles)',
      leading: <UserIcon aria-hidden="true" />,
      keywords: ['mine', 'myself'],
    },
    {
      value: 'unassigned',
      label: 'Unassigned',
      leading: <UserXIcon aria-hidden="true" />,
      keywords: ['nobody', 'none'],
    },
    ...users
      .filter((user) => user.id !== currentUserId)
      .map((user) => ({
        value: `user:${user.id}`,
        label: user.name,
        leading: <UserAvatar user={user} size="sm" />,
        keywords: isAgentUser(user) ? [user.username, 'agent', 'ai'] : [user.username],
        group: 'People',
      })),
    ...roles.map((role) => ({
      value: `role:${role.id}`,
      label: role.name,
      leading: <Dot color={role.color} />,
      keywords: [role.slug, 'role'],
      group: 'Roles',
    })),
  ];
  const count = activeFilterCount(filters);

  return (
    <div className="flex flex-col gap-2">
      <div className="flex min-w-0 items-center gap-2">
        <div className="relative w-full sm:max-w-72">
          <SearchIcon
            aria-hidden="true"
            className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
          />
          <Input
            id={FILTER_SEARCH_ID}
            value={text}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                setText('');
                event.currentTarget.blur();
              }
            }}
            placeholder="Filter tasks…"
            aria-label="Filter tasks by text"
            className="h-8 pr-9 pl-8"
            autoComplete="off"
          />
          <Kbd className="pointer-events-none absolute top-1/2 right-2 hidden -translate-y-1/2 sm:inline-flex">
            /
          </Kbd>
        </div>
        {actions ? <div className="ml-auto flex shrink-0 items-center gap-2">{actions}</div> : null}
      </div>
      <div className="relative -mx-4 flex items-center gap-1.5 overflow-x-auto px-4 pb-1 md:mx-0 md:flex-wrap md:overflow-visible md:px-0 md:pb-0">
        <FilterPopover
          label="Status"
          icon={CircleIcon}
          values={filters.status}
          onChange={set('status')}
          options={statuses.map((status) => ({
            value: status.id,
            label: status.name,
            leading: <StatusIcon status={status} />,
          }))}
        />
        <FilterPopover
          label="Assignee"
          icon={UsersIcon}
          values={filters.assignee}
          onChange={set('assignee')}
          options={people}
        />
        <FilterPopover
          label="Label"
          icon={TagIcon}
          values={filters.label}
          onChange={set('label')}
          options={labels.map((label) => ({
            value: label.id,
            label: label.name,
            leading: <Dot color={label.color} />,
          }))}
        />
        <FilterPopover
          label="Priority"
          icon={SignalHighIcon}
          values={filters.priority}
          onChange={set('priority')}
          searchable={false}
          options={[...PRIORITIES].reverse().map((priority) => ({
            value: String(priority.value),
            label: priority.label,
            leading: <PriorityIcon value={priority.value} />,
          }))}
        />
        <FilterPopover
          label="Due"
          icon={CalendarIcon}
          single
          searchable={false}
          values={filters.due ? [filters.due] : []}
          onChange={single('due')}
          options={[
            { value: 'overdue', label: 'Overdue' },
            { value: 'today', label: 'Due today' },
            { value: 'week', label: 'Due within 7 days' },
            { value: 'none', label: 'No due date' },
          ]}
        />
        <FilterPopover
          label="Claim"
          icon={HandIcon}
          single
          searchable={false}
          values={filters.claimed ? [filters.claimed] : []}
          onChange={single('claimed')}
          options={[
            { value: 'yes', label: 'Claimed' },
            { value: 'no', label: 'Not claimed' },
            { value: 'mine', label: 'Claimed by me' },
          ]}
        />
        <FilterPopover
          label="Blocked"
          icon={BanIcon}
          single
          searchable={false}
          values={filters.blocked ? [filters.blocked] : []}
          onChange={single('blocked')}
          options={[
            { value: 'yes', label: 'Blocked' },
            { value: 'no', label: 'Not blocked', leading: <CircleDashedIcon aria-hidden="true" /> },
          ]}
        />
        {count > 0 ? (
          <Button
            variant="ghost"
            size="sm"
            className="shrink-0 text-muted-foreground"
            onClick={() => {
              setText('');
              lastSent.current = '';
              onChange(() => EMPTY_FILTERS);
            }}
          >
            <XIcon aria-hidden="true" />
            Clear
          </Button>
        ) : null}
        {extra ? (
          <div className="ml-auto flex shrink-0 items-center gap-2 pl-2">{extra}</div>
        ) : null}
      </div>
    </div>
  );
}
