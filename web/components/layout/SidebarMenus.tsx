import { useQueryClient } from '@tanstack/react-query';
import {
  ArrowDownIcon,
  ArrowUpIcon,
  ChevronsDownUpIcon,
  ChevronsUpDownIcon,
  FolderPlusIcon,
  KanbanSquareIcon,
  LinkIcon,
  LogOutIcon,
  MessagesSquareIcon,
  PinIcon,
  PinOffIcon,
  SettingsIcon,
  SquarePenIcon,
  UserCogIcon,
  UserPlusIcon,
  UsersIcon,
  WorkflowIcon,
  type LucideIcon,
} from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router';
import { toast } from 'sonner';
import type { MeProject, MeTeam } from '@shared/schemas/core';
import type { Pipeline } from '@shared/schemas/projects';
import { ConfirmDialog } from '@web/components/common/ConfirmDialog';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuTrigger,
} from '@web/components/ui/context-menu';
import { useSidebar } from '@web/components/ui/sidebar';
import { hotkeyLabels } from '@web/lib/hotkeys';
import { copyLink } from '@web/lib/links';
import { queryKeys } from '@web/lib/queryKeys';
import { runShellAction, useShellActionAvailable } from '@web/lib/shellActions';
import { InviteDialog } from '@web/pages/teams/InviteDialog';
import { useLeaveTeam } from '@web/pages/teams/api';
import { pipelineBoardPath } from '@web/pages/tasks/pipelineTab';
import { projectSettingsPath } from '@web/pages/tasks/settingsPaths';
import { useTogglePin } from './sidebarTeams';

/**
 * Right-click menus of the sidebar's teams, projects (and Pinned entries) and pipelines. Each
 * wraps its row: a right-click (or the Menu key / Shift+F10 on the focused link) opens it, a
 * normal click still follows the link. Actions the viewer can't take are left out.
 */

/** A menu row: icon, label and an optional keyboard hint. */
export function MenuRow({
  icon: Icon,
  label,
  shortcut,
  onSelect,
  destructive = false,
  disabled = false,
}: {
  icon: LucideIcon;
  label: string;
  /** Hotkey syntax (`c`, `g d`), shown as a hint. */
  shortcut?: string | undefined;
  onSelect: () => void;
  destructive?: boolean;
  disabled?: boolean;
}) {
  return (
    <ContextMenuItem
      onSelect={onSelect}
      disabled={disabled}
      variant={destructive ? 'destructive' : 'default'}
    >
      <Icon aria-hidden="true" />
      {label}
      {shortcut ? (
        <ContextMenuShortcut>
          {hotkeyLabels(shortcut)
            .map((caps) => caps.join('+'))
            .join(' ')}
        </ContextMenuShortcut>
      ) : null}
    </ContextMenuItem>
  );
}

/** Navigates and closes the phone sidebar sheet. */
function useGo() {
  const navigate = useNavigate();
  const { setOpenMobile } = useSidebar();
  return (path: string) => {
    setOpenMobile(false);
    void navigate(path);
  };
}

const has = (permissions: readonly string[], permission: string) =>
  permissions.includes(permission) || permissions.includes('ADMINISTRATOR');

// ---------------------------------------------------------------------------------------------
// Team
// ---------------------------------------------------------------------------------------------

export function TeamContextMenu({
  team,
  onToggleFold,
  children,
}: {
  team: MeTeam;
  /** Fold or unfold its projects (left out when it has none). */
  onToggleFold?: (() => void) | undefined;
  children: ReactNode;
}) {
  const go = useGo();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const canCreateProject =
    useShellActionAvailable('project.create') && has(team.permissions, 'MANAGE_PROJECTS');
  const canInvite = has(team.permissions, 'CREATE_INVITES');
  const leave = useLeaveTeam(team.id);
  const [inviting, setInviting] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const base = `/t/${team.slug}`;
  return (
    <>
      <ContextMenu>
        <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
        <ContextMenuContent className="w-52" aria-label={`${team.name} actions`}>
          <MenuRow icon={UsersIcon} label="Open team" onSelect={() => go(base)} />
          {canCreateProject ? (
            <MenuRow
              icon={FolderPlusIcon}
              label="New project…"
              onSelect={() => runShellAction('project.create', { teamId: team.id })}
            />
          ) : null}
          {canInvite ? (
            <MenuRow
              icon={UserPlusIcon}
              label="Invite people…"
              onSelect={() => setInviting(true)}
            />
          ) : null}
          <MenuRow icon={UsersIcon} label="Members" onSelect={() => go(`${base}/members`)} />
          <MenuRow
            icon={SettingsIcon}
            label="Team settings"
            onSelect={() => go(`${base}/settings/general`)}
          />
          <MenuRow icon={UserCogIcon} label="Your settings" onSelect={() => go(`${base}/me`)} />
          {onToggleFold ? (
            <MenuRow
              icon={team.collapsed ? ChevronsUpDownIcon : ChevronsDownUpIcon}
              label={team.collapsed ? 'Unfold projects' : 'Fold projects'}
              onSelect={onToggleFold}
            />
          ) : null}
          <ContextMenuSeparator />
          <MenuRow icon={LinkIcon} label="Copy link" onSelect={() => copyLink(base)} />
          {team.isOwner ? null : (
            <>
              <ContextMenuSeparator />
              <MenuRow
                icon={LogOutIcon}
                label="Leave team…"
                destructive
                onSelect={() => setLeaving(true)}
              />
            </>
          )}
        </ContextMenuContent>
      </ContextMenu>
      {canInvite ? (
        <InviteDialog
          teamId={team.id}
          teamName={team.name}
          open={inviting}
          onOpenChange={setInviting}
        />
      ) : null}
      <ConfirmDialog
        open={leaving}
        onOpenChange={setLeaving}
        title={`Leave ${team.name}?`}
        description="You’ll lose access to its projects. You’ll need a new invite to come back."
        confirmLabel="Leave team"
        destructive
        onConfirm={async () => {
          await leave.mutateAsync();
          await navigate('/');
          await queryClient.invalidateQueries({ queryKey: queryKeys.me() });
          toast.success(`You left ${team.name}`);
        }}
      />
    </>
  );
}

// ---------------------------------------------------------------------------------------------
// Project
// ---------------------------------------------------------------------------------------------

export function ProjectContextMenu({
  team,
  project,
  onMoveUp,
  onMoveDown,
  children,
}: {
  team: MeTeam;
  project: MeProject;
  /** Move within its list (the team's projects, or the Pinned section). */
  onMoveUp?: (() => void) | undefined;
  onMoveDown?: (() => void) | undefined;
  children: ReactNode;
}) {
  const go = useGo();
  const { isPinned, toggle } = useTogglePin();
  const canCreateTask =
    useShellActionAvailable('task.create') &&
    (project.permissions ?? team.permissions).includes('CREATE_TASKS');
  const base = `/t/${team.slug}/p/${project.key}`;
  const pinned = isPinned(project.id);
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      <ContextMenuContent className="w-56" aria-label={`${project.name} actions`}>
        <MenuRow
          icon={pinned ? PinOffIcon : PinIcon}
          label={pinned ? 'Unpin' : 'Pin to top'}
          onSelect={() => toggle(project, !pinned)}
        />
        {onMoveUp || onMoveDown ? (
          <>
            <MenuRow
              icon={ArrowUpIcon}
              label="Move up"
              disabled={!onMoveUp}
              onSelect={() => onMoveUp?.()}
            />
            <MenuRow
              icon={ArrowDownIcon}
              label="Move down"
              disabled={!onMoveDown}
              onSelect={() => onMoveDown?.()}
            />
          </>
        ) : null}
        <ContextMenuSeparator />
        <MenuRow icon={KanbanSquareIcon} label="Open board" onSelect={() => go(`${base}/tasks`)} />
        {canCreateTask ? (
          <MenuRow
            icon={SquarePenIcon}
            label="New task…"
            onSelect={() => runShellAction('task.create', { projectId: project.id })}
          />
        ) : null}
        <MenuRow icon={MessagesSquareIcon} label="Issues" onSelect={() => go(`${base}/issues`)} />
        <MenuRow
          icon={SettingsIcon}
          label="Project settings"
          onSelect={() => go(`${base}/settings/general`)}
        />
        <MenuRow icon={UserCogIcon} label="Your settings" onSelect={() => go(`${base}/me`)} />
        <ContextMenuSeparator />
        <MenuRow icon={LinkIcon} label="Copy link" onSelect={() => copyLink(base)} />
      </ContextMenuContent>
    </ContextMenu>
  );
}

// ---------------------------------------------------------------------------------------------
// Pipeline
// ---------------------------------------------------------------------------------------------

export function PipelineContextMenu({
  projectBase,
  projectId,
  pipeline,
  children,
}: {
  projectBase: string;
  projectId: string;
  pipeline: Pipeline;
  children: ReactNode;
}) {
  const go = useGo();
  const canCreate = useShellActionAvailable('task.create') && pipeline.canCreateTasks;
  const board = pipelineBoardPath(projectBase, pipeline.id);
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      <ContextMenuContent className="w-52" aria-label={`${pipeline.name} actions`}>
        <MenuRow icon={KanbanSquareIcon} label="Open board" onSelect={() => go(board)} />
        {pipeline.canManage ? (
          <MenuRow
            icon={WorkflowIcon}
            label="Edit stages"
            onSelect={() =>
              go(projectSettingsPath(projectBase, 'pipelines', undefined, pipeline.id))
            }
          />
        ) : null}
        {canCreate ? (
          <MenuRow
            icon={SquarePenIcon}
            label="New task here…"
            onSelect={() => runShellAction('task.create', { projectId, pipelineId: pipeline.id })}
          />
        ) : null}
        <ContextMenuSeparator />
        <MenuRow icon={LinkIcon} label="Copy link" onSelect={() => copyLink(board)} />
      </ContextMenuContent>
    </ContextMenu>
  );
}
