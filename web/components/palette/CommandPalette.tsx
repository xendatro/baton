import {
  FolderKanbanIcon,
  HomeIcon,
  InboxIcon,
  KeyboardIcon,
  ListChecksIcon,
  LogOutIcon,
  MessagesSquareIcon,
  MonitorIcon,
  MoonIcon,
  PlusIcon,
  SettingsIcon,
  SunIcon,
  UsersIcon,
  type LucideIcon,
} from 'lucide-react';
import { Command as CommandPrimitive } from 'cmdk';
import { Fragment, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { Kbd } from '@web/components/common/Kbd';
import { Spinner } from '@web/components/common/Spinner';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@web/components/ui/command';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@web/components/ui/dialog';
import { useMe, useSignOut } from '@web/lib/auth';
import { commandFilter } from '@web/lib/commandFilter';
import { highlightSegments } from '@web/lib/highlight';
import { setShortcutsHelpOpen } from '@web/lib/hotkeys';
import { useShellActionAvailable, runShellAction } from '@web/lib/shellActions';
import { useTheme } from '@web/lib/theme';
import {
  setPaletteOpen,
  usePaletteOpen,
  useRegisteredCommands,
  useSearchProviders,
  type PaletteCommand,
  type PaletteSearchResult,
} from './registry';

interface ProviderResults {
  id: string;
  group: string;
  /** The query these results are for (the previous query's stay shown while the next loads). */
  query: string;
  loading: boolean;
  results: PaletteSearchResult[];
}

const SEARCH_DEBOUNCE_MS = 200;

/** Runs the registered search providers for `query` (debounced, cancelling stale searches). */
function useProviderSearch(query: string): ProviderResults[] {
  const providers = useSearchProviders();
  const [state, setState] = useState<ProviderResults[]>([]);
  const trimmed = query.trim();

  useEffect(() => {
    const active = providers.filter((provider) => trimmed.length >= (provider.minQueryLength ?? 2));
    const controller = new AbortController();
    const timer = setTimeout(() => {
      setState(
        active.map((p) => ({
          id: p.id,
          group: p.group,
          query: trimmed,
          loading: true,
          results: [],
        })),
      );
      for (const provider of active) {
        void provider
          .search(trimmed, controller.signal)
          .catch((): PaletteSearchResult[] => [])
          .then((results) => {
            if (controller.signal.aborted) return;
            setState((current) =>
              current.map((entry) =>
                entry.id === provider.id ? { ...entry, loading: false, results } : entry,
              ),
            );
          });
      }
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [providers, trimmed]);

  return trimmed ? state : [];
}

/** Groups with results in the order of their best-ranked result (unranked ones keep their place). */
function byRank(search: ProviderResults[]): ProviderResults[] {
  const best = (provider: ProviderResults) => provider.results[0]?.rank ?? Infinity;
  return search
    .map((provider, index) => ({ provider, index }))
    .sort((a, b) => best(a.provider) - best(b.provider) || a.index - b.index)
    .map(({ provider }) => provider);
}

/** cmdk value of a search result item. */
const resultValue = (providerId: string, resultId: string) => `${providerId}.${resultId}`;

/**
 * The item to select once search results arrive: the first result, which the list shows above
 * the commands. cmdk selects the best command as you type, but results are mounted later (and
 * force-mounted, so cmdk never re-selects), which left Enter on a command below them or on
 * nothing at all. Null while results are loading or when there are none.
 */
function firstResultValue(search: ProviderResults[], query: string): string | null {
  const trimmed = query.trim();
  if (search.some((provider) => provider.query !== trimmed || provider.loading)) return null;
  for (const provider of search) {
    const first = provider.results[0];
    if (first) return resultValue(provider.id, first.id);
  }
  return null;
}

interface Entry {
  id: string;
  label: string;
  icon: LucideIcon;
  keywords?: string[];
  shortcut?: string;
  perform: () => void;
}

/** Ctrl/Cmd+K: jump to pages, teams and projects, run actions, and search (SPEC §1.9). */
export function CommandPalette() {
  const open = usePaletteOpen();
  return (
    <Dialog open={open} onOpenChange={setPaletteOpen}>
      <DialogContent
        className="top-[15%] translate-y-0 overflow-hidden p-0 sm:max-w-xl"
        showCloseButton={false}
      >
        <DialogTitle className="sr-only">Command palette</DialogTitle>
        <DialogDescription className="sr-only">
          Search for pages, teams, projects and actions.
        </DialogDescription>
        {open ? <PaletteBody /> : null}
      </DialogContent>
    </Dialog>
  );
}

function PaletteBody() {
  const navigate = useNavigate();
  const me = useMe().data;
  const signOut = useSignOut();
  const { setTheme } = useTheme();
  const canCreateTeam = useShellActionAvailable('team.create');
  const registered = useRegisteredCommands();
  const [query, setQuery] = useState('');
  const search = byRank(useProviderSearch(query));
  // The selection is controlled so it can move to the first search result when results arrive,
  // unless the viewer already moved it (arrow keys or the pointer) for this query.
  const [selected, setSelected] = useState('');
  const movedByViewer = useRef(false);

  const run = (perform: () => void) => {
    setPaletteOpen(false);
    perform();
  };
  const go = (path: string) => () => void navigate(path);

  const navigation: Entry[] = [
    { id: 'nav.dashboard', label: 'Dashboard', icon: HomeIcon, shortcut: 'g d', perform: go('/') },
    { id: 'nav.inbox', label: 'Inbox', icon: InboxIcon, shortcut: 'g i', perform: go('/inbox') },
    {
      id: 'nav.my-tasks',
      label: 'My tasks',
      icon: ListChecksIcon,
      shortcut: 'g m',
      perform: go('/my-tasks'),
    },
    {
      id: 'nav.settings',
      label: 'Settings',
      icon: SettingsIcon,
      keywords: ['account', 'profile', 'preferences'],
      perform: go('/settings'),
    },
  ];

  const places: Entry[] = (me?.teams ?? []).flatMap((team) => [
    {
      id: `team.${team.id}`,
      label: team.name,
      icon: UsersIcon,
      keywords: [team.slug, 'team'],
      perform: go(`/t/${team.slug}`),
    },
    ...team.projects.flatMap((project): Entry[] => {
      const base = `/t/${team.slug}/p/${project.key}`;
      const words = [project.key, team.name, team.slug];
      return [
        {
          id: `project.${project.id}`,
          label: `${project.name}`,
          icon: FolderKanbanIcon,
          keywords: [...words, 'project', 'overview'],
          perform: go(base),
        },
        {
          id: `project.${project.id}.tasks`,
          label: `${project.name} › Tasks`,
          icon: ListChecksIcon,
          keywords: [...words, 'board', 'list', 'tasks'],
          perform: go(`${base}/tasks`),
        },
        {
          id: `project.${project.id}.issues`,
          label: `${project.name} › Issues`,
          icon: MessagesSquareIcon,
          keywords: [...words, 'issues', 'forum'],
          perform: go(`${base}/issues`),
        },
      ];
    }),
  ]);

  const actions: Entry[] = [
    ...(canCreateTeam
      ? [
          {
            id: 'team.create',
            label: 'Create a team',
            icon: PlusIcon,
            keywords: ['new team'],
            perform: () => void runShellAction('team.create'),
          },
        ]
      : []),
    {
      id: 'theme.light',
      label: 'Theme: Light',
      icon: SunIcon,
      keywords: ['toggle theme', 'appearance'],
      perform: () => setTheme('light'),
    },
    {
      id: 'theme.dark',
      label: 'Theme: Dark',
      icon: MoonIcon,
      keywords: ['toggle theme', 'appearance'],
      perform: () => setTheme('dark'),
    },
    {
      id: 'theme.system',
      label: 'Theme: System',
      icon: MonitorIcon,
      keywords: ['toggle theme', 'appearance', 'auto'],
      perform: () => setTheme('system'),
    },
    {
      id: 'help.shortcuts',
      label: 'Keyboard shortcuts',
      icon: KeyboardIcon,
      shortcut: '?',
      keywords: ['help', 'hotkeys'],
      perform: () => setShortcutsHelpOpen(true),
    },
    {
      id: 'account.sign-out',
      label: 'Sign out',
      icon: LogOutIcon,
      keywords: ['log out', 'logout'],
      perform: () => void signOut(),
    },
  ];

  const registeredGroups = new Map<string, PaletteCommand[]>();
  for (const command of registered) {
    registeredGroups.set(command.group, [...(registeredGroups.get(command.group) ?? []), command]);
  }

  // Typing a command's full name ("inbox", a project's name) and Enter runs that command, which
  // cmdk selects; otherwise the first search result is selected once results arrive.
  const typed = query.trim().toLowerCase();
  const namesCommand = [...navigation, ...places, ...actions, ...registered].some(
    (entry) => entry.label.toLowerCase() === typed,
  );
  const autoSelect = namesCommand ? null : firstResultValue(search, query);
  useEffect(() => {
    if (autoSelect && !movedByViewer.current) setSelected(autoSelect);
  }, [autoSelect]);

  const renderEntry = (entry: Entry | PaletteCommand) => {
    const Icon = entry.icon;
    return (
      <CommandItem
        key={entry.id}
        value={entry.id}
        keywords={[entry.label, ...(entry.keywords ?? [])]}
        onSelect={() => run(entry.perform)}
      >
        {Icon ? <Icon aria-hidden="true" /> : null}
        <span className="truncate">{entry.label}</span>
        {entry.shortcut ? <Kbd keys={entry.shortcut} className="ml-auto" /> : null}
      </CommandItem>
    );
  };

  return (
    // Items are scored on their labels only, and weak fuzzy matches are dropped, so the best match
    // across all groups is the one Enter runs. vimBindings off: Ctrl+K must close the palette
    // (the global toggle), not move the selection up.
    <Command
      loop
      filter={commandFilter}
      vimBindings={false}
      value={selected}
      onValueChange={setSelected}
      onKeyDown={(event) => {
        if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
          movedByViewer.current = true;
        }
      }}
      className="[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:text-xs"
    >
      <CommandInput
        value={query}
        onValueChange={(next) => {
          movedByViewer.current = false;
          setQuery(next);
        }}
        placeholder="Search or jump to…"
        aria-label="Search or jump to"
        className="h-12"
      />
      <CommandList
        className="max-h-[min(60vh,26rem)]"
        onPointerMove={() => {
          movedByViewer.current = true;
        }}
      >
        {/* cmdk doesn't count force-mounted search results, so its empty state would show beside them. */}
        {search.some((provider) => provider.loading || provider.results.length > 0) ? null : (
          <CommandEmpty>No results.</CommandEmpty>
        )}
        {[...registeredGroups.entries()].map(([group, commands]) => (
          <CommandGroup key={group} heading={group}>
            {commands.map(renderEntry)}
          </CommandGroup>
        ))}
        {search
          .filter((provider) => provider.loading || provider.results.length > 0)
          .map((provider) => (
            <CommandGroup key={provider.id} heading={provider.group} forceMount>
              {provider.loading ? (
                <CommandPrimitive.Loading>
                  <div className="flex items-center gap-2 px-2 py-1.5 text-sm text-muted-foreground">
                    <Spinner /> Searching…
                  </div>
                </CommandPrimitive.Loading>
              ) : null}
              {provider.results.map((result) => {
                const Icon = result.icon;
                return (
                  <CommandItem
                    key={resultValue(provider.id, result.id)}
                    value={resultValue(provider.id, result.id)}
                    keywords={[result.label]}
                    forceMount
                    onSelect={() => run(go(result.href))}
                  >
                    {Icon ? <Icon aria-hidden="true" /> : null}
                    <span className="min-w-0 flex-1">
                      <span className="flex min-w-0 items-baseline gap-2">
                        {result.ref ? (
                          <span className="shrink-0 font-mono text-xs text-muted-foreground">
                            {result.ref}
                          </span>
                        ) : null}
                        <span className="truncate">
                          <Highlighted text={result.label} terms={result.highlight} />
                        </span>
                      </span>
                      {result.description ? (
                        <span className="block truncate text-xs text-muted-foreground">
                          <Highlighted text={result.description} terms={result.highlight} />
                        </span>
                      ) : null}
                    </span>
                    {result.hint ? (
                      <span className="ml-2 hidden max-w-[35%] shrink-0 truncate text-xs text-muted-foreground sm:block">
                        {result.hint}
                      </span>
                    ) : null}
                  </CommandItem>
                );
              })}
            </CommandGroup>
          ))}
        <CommandGroup heading="Go to">{navigation.map(renderEntry)}</CommandGroup>
        {places.length ? (
          <CommandGroup heading="Teams & projects">{places.map(renderEntry)}</CommandGroup>
        ) : null}
        <CommandGroup heading="Actions">{actions.map(renderEntry)}</CommandGroup>
      </CommandList>
    </Command>
  );
}

/** `text` with the search terms in bold. */
function Highlighted({ text, terms }: { text: string; terms?: readonly string[] | undefined }) {
  if (!terms?.length) return text;
  return highlightSegments(text, terms).map((segment, index) =>
    segment.match ? (
      <mark key={index} className="rounded-sm bg-transparent font-semibold text-foreground">
        {segment.text}
      </mark>
    ) : (
      <Fragment key={index}>{segment.text}</Fragment>
    ),
  );
}
