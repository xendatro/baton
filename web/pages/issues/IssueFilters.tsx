import {
  ArrowDownUpIcon,
  CheckIcon,
  ChevronDownIcon,
  SearchIcon,
  TagIcon,
  UserIcon,
  XIcon,
} from 'lucide-react';
import { useState, type Ref } from 'react';
import {
  ISSUE_SORT_LABELS,
  ISSUE_SORTS,
  type IssueCounts,
  type IssueSort,
  type IssueState,
  type LabelMatch,
} from '@shared/schemas/issues';
import type { Label } from '@shared/schemas/projects';
import type { UserSummary } from '@shared/schemas/core';
import { Kbd } from '@web/components/common/Kbd';
import { UserAvatar } from '@web/components/common/UserAvatar';
import { LabelPicker } from '@web/components/pickers/LabelPicker';
import { PickerShell } from '@web/components/pickers/PickerShell';
import { Button } from '@web/components/ui/button';
import { CommandGroup, CommandItem } from '@web/components/ui/command';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@web/components/ui/dropdown-menu';
import { Input } from '@web/components/ui/input';
import { cn } from '@web/lib/utils';
import { IssueStateIcon } from './IssueState';

/** Open / Resolved / All, with counts (the forum-style tabs of the issue list). */
export function StateTabs({
  value,
  counts,
  onChange,
}: {
  value: IssueState;
  counts: IssueCounts | undefined;
  onChange: (state: IssueState) => void;
}) {
  const tabs: Array<{ state: IssueState; label: string }> = [
    { state: 'open', label: 'Open' },
    { state: 'resolved', label: 'Resolved' },
    { state: 'all', label: 'All' },
  ];
  return (
    <div
      role="group"
      aria-label="Issue state"
      className="-m-1 flex min-w-0 items-center gap-1 overflow-x-auto p-1"
    >
      {tabs.map((tab) => {
        const active = tab.state === value;
        return (
          <button
            key={tab.state}
            type="button"
            aria-pressed={active}
            onClick={() => onChange(tab.state)}
            className={cn(
              'inline-flex h-8 items-center gap-1.5 rounded-md px-2.5 text-sm font-medium transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring',
              active
                ? 'bg-accent text-foreground'
                : 'text-muted-foreground hover:bg-accent/60 hover:text-foreground',
            )}
          >
            {tab.state === 'all' ? null : (
              <IssueStateIcon
                decorative
                resolved={tab.state === 'resolved'}
                className={cn(
                  'size-3.5',
                  !active && 'text-muted-foreground dark:text-muted-foreground',
                )}
              />
            )}
            {tab.label}
            <span
              className={cn(
                'min-w-5 rounded-full px-1.5 text-center text-xs tabular-nums',
                active ? 'bg-background text-foreground' : 'bg-muted text-muted-foreground',
              )}
            >
              {counts ? counts[tab.state] : '–'}
            </span>
          </button>
        );
      })}
    </div>
  );
}

export function SearchBox({
  value,
  onChange,
  ref,
}: {
  value: string;
  onChange: (value: string) => void;
  ref?: Ref<HTMLInputElement>;
}) {
  return (
    <div className="relative w-full min-w-0 sm:w-auto sm:max-w-72 sm:flex-1">
      <SearchIcon
        className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
        aria-hidden="true"
      />
      <Input
        ref={ref}
        type="search"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            if (value) onChange('');
            else event.currentTarget.blur();
          }
        }}
        placeholder="Search issues…"
        aria-label="Search issues"
        className="h-8 pr-8 pl-8"
      />
      {value ? null : (
        <Kbd
          keys="/"
          className="pointer-events-none absolute top-1/2 right-2 hidden -translate-y-1/2 sm:inline-flex"
        />
      )}
    </div>
  );
}

/** Label filter: the shared label picker with a count on its trigger, plus Any/All matching. */
export function LabelFilter({
  labels,
  value,
  match,
  onChange,
  onMatchChange,
}: {
  labels: readonly Label[];
  value: readonly string[];
  match: LabelMatch;
  onChange: (labelIds: string[]) => void;
  onMatchChange: (match: LabelMatch) => void;
}) {
  const count = value.length;
  return (
    <div className="flex items-center gap-1">
      <LabelPicker labels={labels} value={value} onChange={onChange} align="start">
        <Button
          variant="outline"
          size="sm"
          aria-label={count ? `Labels: ${count} selected` : 'Filter by label'}
          className={cn(count > 0 && 'border-primary/50')}
        >
          <TagIcon aria-hidden="true" />
          Labels
          {count > 0 ? <FilterCount count={count} /> : null}
          <ChevronDownIcon className="text-muted-foreground" aria-hidden="true" />
        </Button>
      </LabelPicker>
      {count > 1 ? (
        <div
          role="group"
          aria-label="Label matching"
          className="flex h-8 items-center rounded-md border p-0.5 text-xs"
        >
          {(['any', 'all'] as const).map((option) => (
            <button
              key={option}
              type="button"
              aria-pressed={match === option}
              onClick={() => onMatchChange(option)}
              title={
                option === 'any' ? 'Issues with any of these labels' : 'Issues with every label'
              }
              className={cn(
                'h-full rounded-sm px-2 font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring',
                match === option
                  ? 'bg-accent text-foreground'
                  : 'text-muted-foreground hover:text-foreground',
              )}
            >
              {option === 'any' ? 'Any' : 'All'}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function FilterCount({ count }: { count: number }) {
  return (
    <span className="rounded-full bg-primary px-1.5 text-xs leading-4 text-primary-foreground tabular-nums">
      {count}
    </span>
  );
}

/** Author filter: any member of the team, or everyone. */
export function AuthorFilter({
  users,
  value,
  onChange,
}: {
  users: readonly UserSummary[];
  value: UserSummary | null;
  onChange: (user: UserSummary | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const pick = (user: UserSummary | null) => {
    onChange(user);
    setOpen(false);
  };
  return (
    <PickerShell
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setSearch('');
      }}
      search={search}
      onSearchChange={setSearch}
      searchPlaceholder="Find a member…"
      emptyText="No members found."
      trigger={
        <Button
          variant="outline"
          size="sm"
          aria-label={value ? `Author: ${value.name}` : 'Filter by author'}
          className={cn('max-w-48', value && 'border-primary/50')}
        >
          {value ? <UserAvatar user={value} size="xs" /> : <UserIcon aria-hidden="true" />}
          <span className="truncate">{value ? value.name : 'Author'}</span>
          <ChevronDownIcon className="text-muted-foreground" aria-hidden="true" />
        </Button>
      }
    >
      <CommandGroup>
        {value ? (
          <CommandItem
            value="__anyone__"
            keywords={['Anyone', 'clear']}
            onSelect={() => pick(null)}
          >
            <XIcon aria-hidden="true" />
            Anyone
          </CommandItem>
        ) : null}
        {users.map((user) => (
          <CommandItem
            key={user.id}
            value={user.id}
            keywords={[user.name, user.username]}
            onSelect={() => pick(user)}
          >
            <UserAvatar user={user} size="sm" />
            <span className="truncate">{user.name}</span>
            <span className="truncate text-xs text-muted-foreground">@{user.username}</span>
            {value?.id === user.id ? (
              <CheckIcon className="ml-auto" aria-label="(selected)" />
            ) : null}
          </CommandItem>
        ))}
      </CommandGroup>
    </PickerShell>
  );
}

export function SortMenu({
  value,
  onChange,
}: {
  value: IssueSort;
  onChange: (sort: IssueSort) => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm" aria-label={`Sort: ${ISSUE_SORT_LABELS[value]}`}>
          <ArrowDownUpIcon aria-hidden="true" />
          <span className="hidden sm:inline">{ISSUE_SORT_LABELS[value]}</span>
          <span className="sm:hidden">Sort</span>
          <ChevronDownIcon className="text-muted-foreground" aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-44">
        <DropdownMenuLabel>Sort by</DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuRadioGroup
          value={value}
          onValueChange={(next) => {
            const sort = ISSUE_SORTS.find((candidate) => candidate === next);
            if (sort) onChange(sort);
          }}
        >
          {ISSUE_SORTS.map((sort) => (
            <DropdownMenuRadioItem key={sort} value={sort}>
              {ISSUE_SORT_LABELS[sort]}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
