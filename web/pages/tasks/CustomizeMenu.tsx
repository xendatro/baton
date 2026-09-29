import {
  KanbanSquareIcon,
  MoreHorizontalIcon,
  Settings2Icon,
  TagsIcon,
  UserCogIcon,
  WorkflowIcon,
} from 'lucide-react';
import { Link } from 'react-router';
import { Button } from '@web/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@web/components/ui/dropdown-menu';
import { cn } from '@web/lib/utils';
import { projectSettingsPath } from './settingsPaths';

/**
 * Shortcuts from the Tasks page to the project settings that shape it: the statuses (the board's
 * columns) and the labels. The settings pages stay the home of both; these are a second way in.
 * Everyone also gets their own settings for the project (BAT-29).
 */

export interface CustomizeMenuProps {
  /** `/t/:team/p/:key`. */
  projectBase: string;
  canManageStatuses: boolean;
  canManageLabels: boolean;
  /** BAT-25: the board's pipeline tab ("Edit stages" opens its stages). */
  pipelineId?: string | undefined;
}

/** The toolbar's "Customize" menu; viewers who can change neither get only Your settings. */
export function CustomizeMenu({
  projectBase,
  canManageStatuses,
  canManageLabels,
  pipelineId,
}: CustomizeMenuProps) {
  const canManage = canManageStatuses || canManageLabels;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm" aria-label="Customize board">
          <Settings2Icon aria-hidden="true" />
          <span className="hidden md:inline">Customize</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-48">
        {canManage ? (
          <DropdownMenuLabel className="text-xs font-medium text-muted-foreground">
            Customize board
          </DropdownMenuLabel>
        ) : null}
        {canManageStatuses ? (
          <DropdownMenuItem asChild>
            <Link to={projectSettingsPath(projectBase, 'pipelines', undefined, pipelineId)}>
              <KanbanSquareIcon aria-hidden="true" />
              Edit stages
            </Link>
          </DropdownMenuItem>
        ) : null}
        {canManageStatuses ? (
          <DropdownMenuItem asChild>
            <Link to={projectSettingsPath(projectBase, 'pipelines')}>
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
        {canManage ? <DropdownMenuSeparator /> : null}
        <DropdownMenuItem asChild>
          <Link to={`${projectBase}/me`}>
            <UserCogIcon aria-hidden="true" />
            Your settings
          </Link>
        </DropdownMenuItem>
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
          // Always visible, like the column's "+" button: hiding it until the column was hovered
          // left it invisible (and flickering with focus) on mouse devices (BAT-32).
          className={cn(
            'size-7 text-muted-foreground data-[state=open]:text-foreground',
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
            Edit stage
          </Link>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
