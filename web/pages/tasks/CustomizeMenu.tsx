import {
  GaugeIcon,
  KanbanSquareIcon,
  MoreHorizontalIcon,
  Settings2Icon,
  TagsIcon,
  WorkflowIcon,
} from 'lucide-react';
import { Link } from 'react-router';
import { Button } from '@web/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '@web/components/ui/dropdown-menu';
import { cn } from '@web/lib/utils';
import { projectSettingsPath } from './settingsPaths';

/**
 * Shortcuts from the Tasks page to the project settings that shape it: the statuses (the board's
 * columns) and the labels. The settings pages stay the home of both; these are a second way in.
 */

export interface CustomizeMenuProps {
  /** `/t/:team/p/:key`. */
  projectBase: string;
  canManageStatuses: boolean;
  canManageLabels: boolean;
  /** BAT-25: the board's pipeline tab ("Edit statuses" opens its stages). */
  pipelineId?: string | undefined;
}

/** The toolbar's "Customize" menu; hidden from viewers who can change neither. */
export function CustomizeMenu({
  projectBase,
  canManageStatuses,
  canManageLabels,
  pipelineId,
}: CustomizeMenuProps) {
  if (!canManageStatuses && !canManageLabels) return null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm" aria-label="Customize board">
          <Settings2Icon aria-hidden="true" />
          <span className="hidden md:inline">Customize</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-48">
        <DropdownMenuLabel className="text-xs font-medium text-muted-foreground">
          Customize board
        </DropdownMenuLabel>
        {canManageStatuses ? (
          <DropdownMenuItem asChild>
            <Link to={projectSettingsPath(projectBase, 'statuses', undefined, pipelineId)}>
              <KanbanSquareIcon aria-hidden="true" />
              Edit statuses
            </Link>
          </DropdownMenuItem>
        ) : null}
        {canManageStatuses ? (
          <DropdownMenuItem asChild>
            <Link to={projectSettingsPath(projectBase, 'statuses')}>
              <WorkflowIcon aria-hidden="true" />
              Manage pipelines
            </Link>
          </DropdownMenuItem>
        ) : null}
        {canManageLabels ? (
          <DropdownMenuItem asChild>
            <Link to={projectSettingsPath(projectBase, 'labels')}>
              <TagsIcon aria-hidden="true" />
              Edit labels
            </Link>
          </DropdownMenuItem>
        ) : null}
        {canManageLabels ? (
          <DropdownMenuItem asChild>
            <Link to={projectSettingsPath(projectBase, 'difficulty')}>
              <GaugeIcon aria-hidden="true" />
              Edit difficulty levels
            </Link>
          </DropdownMenuItem>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * A board column's "…" menu. Shown faintly until the column is hovered or focused on devices
 * with a mouse, always on touch screens.
 */
export function ColumnMenu({
  statusName,
  editHref,
  className,
}: {
  statusName: string;
  editHref: string;
  className?: string;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className={cn(
            'size-7 text-muted-foreground transition-opacity data-[state=open]:opacity-100',
            '[@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-focus-within/column:opacity-100 [@media(hover:hover)]:group-hover/column:opacity-100',
            className,
          )}
          aria-label={`${statusName} column actions`}
        >
          <MoreHorizontalIcon aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-44">
        <DropdownMenuItem asChild>
          <Link to={editHref}>
            <KanbanSquareIcon aria-hidden="true" />
            Edit statuses
          </Link>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
