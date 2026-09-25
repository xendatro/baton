import {
  BotIcon,
  BoxIcon,
  FolderKanbanIcon,
  GlobeIcon,
  UserIcon,
  XIcon,
  ZapIcon,
} from 'lucide-react';
import type { ActivityEntityType, ActorSource } from '@shared/constants';
import type { AuditLogFacets } from '@shared/schemas/admin';
import { UserAvatar } from '@web/components/common/UserAvatar';
import { Button } from '@web/components/ui/button';
import { DateRangeFilter } from './DateRangeFilter';
import { FilterMenu, type FilterOption } from './FilterMenu';
import { actionOptions, ENTITY_LABELS, SOURCE_LABELS } from './labels';
import { activeFilterCount, EMPTY_FILTERS, type AuditFilters as Filters } from './filters';

export interface AuditFiltersProps {
  filters: Filters;
  facets: AuditLogFacets | undefined;
  loading: boolean;
  onChange: (filters: Filters) => void;
}

/** The audit log's filter bar; every filter lives in the URL. */
export function AuditFilterBar({ filters, facets, loading, onChange }: AuditFiltersProps) {
  const set = <K extends keyof Filters>(key: K, value: Filters[K]) =>
    onChange({ ...filters, [key]: value });
  const active = activeFilterCount(filters);

  const actorOptions: FilterOption[] = (facets?.actors ?? []).map((user) => ({
    value: user.id,
    label: user.name,
    description: `@${user.username}`,
    leading: <UserAvatar user={user} size="sm" />,
    keywords: [user.username],
  }));
  const keyOptions: FilterOption[] = (facets?.keys ?? []).map((key) => ({
    value: key.keyId,
    label: key.keyName,
    description: key.user ? `${key.user.name} · @${key.user.username}` : 'Deleted user',
    leading: <BotIcon aria-hidden="true" />,
  }));
  const sources = facets?.sources.length
    ? facets.sources
    : (['web', 'mcp', 'api', 'system'] as const);
  const sourceOptions: FilterOption[] = sources.map((source) => ({
    value: source,
    label: SOURCE_LABELS[source],
  }));
  const entityOptions: FilterOption[] = (facets?.entityTypes ?? []).map((type) => ({
    value: type,
    label: ENTITY_LABELS[type],
  }));
  const projectOptions: FilterOption[] = (facets?.projects ?? []).map((project) => ({
    value: project.id,
    label: project.name,
    description: project.deleted ? `${project.key} · in Trash` : project.key,
    keywords: [project.key],
  }));

  return (
    <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Filters">
      <FilterMenu
        label="Actor"
        icon={UserIcon}
        value={filters.actor}
        options={actorOptions}
        unknownLabel="Former member"
        loading={loading}
        onChange={(value) => set('actor', value)}
      />
      <FilterMenu
        label="Source"
        icon={GlobeIcon}
        value={filters.source}
        options={sourceOptions}
        loading={loading}
        onChange={(value) => set('source', value as ActorSource | null)}
      />
      <FilterMenu
        label="Key"
        icon={BotIcon}
        value={filters.key}
        options={keyOptions}
        unknownLabel="Deleted key"
        searchPlaceholder="Search API keys…"
        loading={loading}
        onChange={(value) => set('key', value)}
      />
      <FilterMenu
        label="Type"
        icon={BoxIcon}
        value={filters.entity}
        options={entityOptions}
        loading={loading}
        onChange={(value) => set('entity', value as ActivityEntityType | null)}
      />
      <FilterMenu
        label="Action"
        icon={ZapIcon}
        value={filters.action}
        options={actionOptions(facets?.actions ?? [])}
        unknownLabel={filters.action ?? undefined}
        loading={loading}
        onChange={(value) => set('action', value)}
      />
      <FilterMenu
        label="Project"
        icon={FolderKanbanIcon}
        value={filters.project}
        options={projectOptions}
        unknownLabel="Deleted project"
        loading={loading}
        onChange={(value) => set('project', value)}
      />
      <DateRangeFilter
        from={filters.from}
        to={filters.to}
        onChange={(range) => onChange({ ...filters, ...range })}
      />
      {active > 0 ? (
        <Button
          variant="ghost"
          size="sm"
          className="text-muted-foreground"
          onClick={() => onChange(EMPTY_FILTERS)}
        >
          <XIcon aria-hidden="true" />
          Clear {active > 1 ? `${active} filters` : 'filter'}
        </Button>
      ) : null}
    </div>
  );
}
