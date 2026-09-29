import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  CheckCircle2Icon,
  CircleDotIcon,
  ExternalLinkIcon,
  HashIcon,
  LinkIcon,
  SquareArrowOutUpRightIcon,
  SquarePenIcon,
} from 'lucide-react';
import type { ReactNode } from 'react';
import { useNavigate } from 'react-router';
import { toast } from 'sonner';
import { issueSchema, type IssueSummary } from '@shared/schemas/issues';
import { MenuRow } from '@web/components/layout/SidebarMenus';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@web/components/ui/context-menu';
import { api, errorMessage } from '@web/lib/api';
import { canOpenNewTab, copyLink, copyToClipboard, openInNewTab } from '@web/lib/links';
import { useProjectAccess } from '@web/lib/permissions';
import { queryKeys } from '@web/lib/queryKeys';
import { useShellActionAvailable } from '@web/lib/shellActions';
import { useIssueLabelsMenu } from './issueLabelsMenu';
import { useOpenCreateTaskFromIssue } from './queries';

const enc = encodeURIComponent;

/**
 * An issue row's right-click menu: open it (here or in a new tab), copy its link or ref, resolve
 * or reopen it (its author, or `RESOLVE_ISSUES`), and create a task from it (`CREATE_TASKS`, like
 * the issue page's "Create task": the New task dialog, prefilled), and add or remove its labels
 * (the same people as resolving, BAT-40). A normal click still opens it.
 */
export function IssueRowMenu({ issue, children }: { issue: IssueSummary; children: ReactNode }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const access = useProjectAccess(issue.teamId, issue.projectId);
  const canTriage = issue.author?.id === access.userId || access.has('RESOLVE_ISSUES');
  const dialogAvailable = useShellActionAvailable('task.create');
  const canCreateTask = access.has('CREATE_TASKS') && dialogAvailable;
  const refresh = () =>
    queryClient.invalidateQueries({ queryKey: queryKeys.issues.all(issue.projectId) });

  const setResolved = useMutation({
    mutationFn: (resolved: boolean) =>
      api.post(`/api/issues/${enc(issue.id)}/${resolved ? 'resolve' : 'reopen'}`, undefined, {
        schema: issueSchema,
      }),
    onSuccess: (updated) => {
      toast.success(updated.resolved ? `${issue.ref} resolved` : `${issue.ref} reopened`);
      return refresh();
    },
    onError: (error) => toast.error(errorMessage(error)),
    meta: { suppressErrorToast: true },
  });
  const labels = useIssueLabelsMenu(issue, 'context', canTriage);
  const openCreateTask = useOpenCreateTaskFromIssue();
  const createTask = () =>
    void openCreateTask(issue, canTriage ? 'fixes' : 'relates').catch((error: unknown) =>
      toast.error(errorMessage(error)),
    );

  return (
    <>
      <ContextMenu>
        <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
        <ContextMenuContent className="w-52" aria-label={`${issue.ref} actions`}>
          <MenuRow
            icon={SquareArrowOutUpRightIcon}
            label="Open"
            shortcut="enter"
            onSelect={() => void navigate(issue.path)}
          />
          {canOpenNewTab() ? (
            <MenuRow
              icon={ExternalLinkIcon}
              label="Open in new tab"
              onSelect={() => openInNewTab(issue.path, (path) => void navigate(path))}
            />
          ) : null}
          <MenuRow icon={LinkIcon} label="Copy link" onSelect={() => copyLink(issue.path)} />
          <MenuRow
            icon={HashIcon}
            label="Copy ref"
            onSelect={() => void copyToClipboard(issue.ref, 'Ref')}
          />
          {canTriage || canCreateTask ? <ContextMenuSeparator /> : null}
          {canTriage ? (
            <MenuRow
              icon={issue.resolved ? CircleDotIcon : CheckCircle2Icon}
              label={issue.resolved ? 'Reopen' : 'Resolve'}
              onSelect={() => setResolved.mutate(!issue.resolved)}
            />
          ) : null}
          {labels.submenu}
          {canCreateTask ? (
            <MenuRow icon={SquarePenIcon} label="Create task…" onSelect={createTask} />
          ) : null}
        </ContextMenuContent>
      </ContextMenu>
      {labels.dialog}
    </>
  );
}
