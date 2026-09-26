import { BellIcon, BellOffIcon, KanbanSquareIcon, PlusIcon, SettingsIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { Link, useNavigate } from 'react-router';
import { toast } from 'sonner';
import type { Issue } from '@shared/schemas/issues';
import { LabelChip } from '@web/components/common/LabelChip';
import { Spinner } from '@web/components/common/Spinner';
import { StatusIcon } from '@web/components/common/StatusBadge';
import { LabelPicker } from '@web/components/pickers/LabelPicker';
import { Button } from '@web/components/ui/button';
import type { TeamAccess } from '@web/lib/permissions';
import { cn } from '@web/lib/utils';
import { useLabels } from '@web/pages/projects/queries';
import { useCreateLabelOption } from './labels';
import { useCreateTaskFromIssue, useSetIssueLabels, useSetIssueSubscription } from './queries';

/** Labels, the tasks addressing the issue, and the reply-notification toggle. */
export function IssueSidebar({
  issue,
  access,
  canTriage,
  projectBase,
  labelsOpen,
  onLabelsOpenChange,
}: {
  issue: Issue;
  access: TeamAccess;
  canTriage: boolean;
  projectBase: string;
  labelsOpen: boolean;
  onLabelsOpenChange: (open: boolean) => void;
}) {
  return (
    <div className="grid content-start gap-5 text-sm">
      <LabelsSection
        issue={issue}
        access={access}
        canTriage={canTriage}
        open={labelsOpen}
        onOpenChange={onLabelsOpenChange}
      />
      <AddressedBySection issue={issue} access={access} projectBase={projectBase} />
      <SubscriptionSection issue={issue} />
    </div>
  );
}

function Section({
  id,
  title,
  action,
  children,
}: {
  id: string;
  title: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section aria-labelledby={id} className="grid gap-2 border-b pb-5 last:border-b-0">
      <div className="flex min-h-7 items-center justify-between gap-2">
        <h3 id={id} className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
          {title}
        </h3>
        {action}
      </div>
      {children}
    </section>
  );
}

function LabelsSection({
  issue,
  access,
  canTriage,
  open,
  onOpenChange,
}: {
  issue: Issue;
  access: TeamAccess;
  canTriage: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const labels = useLabels(issue.projectId);
  const setLabels = useSetIssueLabels(issue, labels.data ?? issue.labels);
  const createLabel = useCreateLabelOption(issue.projectId, access.has('MANAGE_LABELS'));
  const chips =
    issue.labels.length > 0 ? (
      <div className="flex flex-wrap gap-1.5">
        {issue.labels.map((label) => (
          <LabelChip key={label.id} label={label} />
        ))}
      </div>
    ) : (
      <p className="text-muted-foreground">None yet</p>
    );
  return (
    <Section
      id="issue-labels"
      title="Labels"
      action={
        canTriage ? (
          <LabelPicker
            labels={labels.data ?? []}
            value={issue.labels.map((label) => label.id)}
            onChange={(ids) => setLabels.mutate(ids)}
            onCreate={createLabel}
            open={open}
            onOpenChange={onOpenChange}
            align="end"
            disabled={labels.isPending}
          >
            <Button
              variant="ghost"
              size="icon-sm"
              className="size-7"
              aria-label="Edit labels"
              aria-keyshortcuts="l"
            >
              <SettingsIcon aria-hidden="true" />
            </Button>
          </LabelPicker>
        ) : null
      }
    >
      {chips}
    </Section>
  );
}

function AddressedBySection({
  issue,
  access,
  projectBase,
}: {
  issue: Issue;
  access: TeamAccess;
  projectBase: string;
}) {
  const navigate = useNavigate();
  const createTask = useCreateTaskFromIssue(issue);
  const canCreateTask = access.has('CREATE_TASKS');
  const create = () =>
    createTask.mutate(undefined, {
      onSuccess: (task) => {
        toast.success(`Task ${task.ref} created`);
        void navigate(`${projectBase}/tasks/${task.number}`);
      },
    });
  return (
    <Section id="issue-addressed-by" title="Addressed by">
      {issue.linkedTasks.length > 0 ? (
        <ul className="grid gap-1.5">
          {issue.linkedTasks.map((task) => (
            <li key={task.id} className="flex min-w-0 items-start gap-2">
              <StatusIcon status={task.status} className="mt-0.5" />
              <div className="min-w-0 flex-1">
                <Link
                  to={task.path}
                  className="line-clamp-2 break-words hover:text-primary hover:underline"
                  title={`${task.ref} ${task.title} (${task.status.name})`}
                >
                  <span className="mr-1 font-mono text-xs text-muted-foreground">{task.ref}</span>
                  {task.title}
                </Link>
                <p className="text-xs text-muted-foreground">
                  {task.status.name}
                  {' · '}
                  <span
                    className={cn(task.kind === 'fixes' && 'font-medium text-foreground')}
                    title={
                      task.kind === 'fixes'
                        ? 'Resolves this issue when the task is done'
                        : 'Related; no automation'
                    }
                  >
                    {task.kind === 'fixes' ? 'fixes' : 'relates'}
                  </span>
                </p>
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <p className="flex items-center gap-1.5 text-muted-foreground">
          <KanbanSquareIcon className="size-4" aria-hidden="true" />
          No tasks yet
        </p>
      )}
      {canCreateTask ? (
        <Button
          variant="outline"
          size="sm"
          className="justify-start justify-self-start lg:justify-self-stretch"
          onClick={create}
          disabled={createTask.isPending}
        >
          {createTask.isPending ? <Spinner /> : <PlusIcon aria-hidden="true" />}
          Create task
        </Button>
      ) : null}
    </Section>
  );
}

function SubscriptionSection({ issue }: { issue: Issue }) {
  const setSubscription = useSetIssueSubscription(issue);
  const toggle = () =>
    setSubscription.mutate(!issue.subscribed, {
      onSuccess: ({ subscribed }) =>
        toast.success(subscribed ? 'Subscribed to replies' : 'Unsubscribed from replies'),
    });
  return (
    <Section id="issue-notifications" title="Notifications">
      <Button
        variant="outline"
        size="sm"
        className="justify-start justify-self-start lg:justify-self-stretch"
        onClick={toggle}
      >
        {issue.subscribed ? <BellOffIcon aria-hidden="true" /> : <BellIcon aria-hidden="true" />}
        {issue.subscribed ? 'Unsubscribe' : 'Subscribe'}
      </Button>
      <p className="text-xs text-muted-foreground">
        {issue.subscribed
          ? 'You’re notified of replies and when it is resolved or reopened.'
          : 'You’re not notified of replies to this issue.'}
      </p>
    </Section>
  );
}
