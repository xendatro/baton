import {
  ArrowRightIcon,
  CheckIcon,
  ChevronRightIcon,
  CircleCheckIcon,
  CircleIcon,
  HandIcon,
  HistoryIcon,
  ShieldCheckIcon,
  TriangleAlertIcon,
  UndoIcon,
  WorkflowIcon,
  XIcon,
} from 'lucide-react';
import { useId, useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import type { StageCriterion, TaskStage } from '@shared/schemas/pipelines';
import type { Task } from '@shared/schemas/tasks';
import { RelativeTime } from '@web/components/common/RelativeTime';
import { Spinner } from '@web/components/common/Spinner';
import { UserName } from '@web/components/common/UserName';
import { MarkdownView } from '@web/components/markdown/MarkdownView';
import { Button } from '@web/components/ui/button';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@web/components/ui/collapsible';
import { Textarea } from '@web/components/ui/textarea';
import { Tooltip, TooltipContent, TooltipTrigger } from '@web/components/ui/tooltip';
import { errorMessage } from '@web/lib/api';
import { cn } from '@web/lib/utils';
import { useClaimAction, useDecideApproval, useSaveEvidence } from './queries';
import { SendBackDialog, type SendBackResult } from './SendBackDialog';

/**
 * The task's stage in the project's pipeline (design §5): why it was sent back (BAT-27), what to do
 * (instructions), the exit criteria with their evidence (editable while the task is in the stage),
 * approvals with Approve / Request changes, Claim for tasks waiting in a pool, what still blocks
 * moving on, the green "Move to <next>" and amber "Send back…" buttons, and the stage history.
 */

export interface StagePanelProps {
  task: Task & { stage: TaskStage };
  teamId: string;
  /** Moves the task on to `stage.next` (the page's status change, with its error handling). */
  onMoveOn?: () => void;
  moving?: boolean;
  /** Sends the task back to an earlier stage with a reason (BAT-27). */
  onSendBack?: (result: SendBackResult) => Promise<unknown>;
}

export function StagePanel({ task, teamId, onMoveOn, moving, onSendBack }: StagePanelProps) {
  const { stage } = task;
  const headingId = useId();
  return (
    <section
      aria-labelledby={headingId}
      className="rounded-lg border bg-card p-4"
      data-testid="stage-panel"
    >
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <WorkflowIcon className="size-4 text-muted-foreground" aria-hidden="true" />
        <h2 id={headingId} className="text-sm font-semibold">
          Stage: {stage.status.name}
        </h2>
        {stage.next ? (
          <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
            <ArrowRightIcon className="size-3.5" aria-hidden="true" />
            Next: {stage.next.name}
            {stage.autoAdvance ? ' (moves on by itself when ready)' : ''}
          </span>
        ) : null}
      </div>

      {stage.returnReason ? <ReturnReason stage={stage} /> : null}

      {stage.instructions.trim() ? (
        <div className="mt-3 text-sm">
          <MarkdownView markdown={stage.instructions} teamId={teamId} />
        </div>
      ) : null}

      {stage.pool ? <PoolClaim task={task} /> : null}

      {stage.criteria.length > 0 ? <Criteria task={task} /> : null}

      {stage.approvals ? <Approvals task={task} /> : null}

      {stage.moveRule ? (
        <p className="mt-3 text-xs text-muted-foreground">Only {stage.moveRule} can move it on.</p>
      ) : null}

      {stage.next ? (
        stage.missing.length > 0 ? (
          <div
            role="status"
            className="mt-4 rounded-md border border-amber-500/40 bg-amber-500/5 px-3 py-2 text-sm"
          >
            <p className="flex items-center gap-1.5 font-medium">
              <TriangleAlertIcon
                className="size-4 text-amber-600 dark:text-amber-400"
                aria-hidden="true"
              />
              To move on to {stage.next.name}, it still needs:
            </p>
            <ul className="mt-1 list-disc pl-6 text-muted-foreground">
              {stage.missing.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          </div>
        ) : null
      ) : null}

      <StageMoves stage={stage} onMoveOn={onMoveOn} moving={moving} onSendBack={onSendBack} />

      <PreviousReviews stage={stage} />
      {stage.previousEvidence.length > 0 ? <PreviousEvidence stage={stage} /> : null}
      {(stage.visits?.length ?? 0) > 1 ? <StageHistory stage={stage} /> : null}
    </section>
  );
}

/** Why the task is back in this stage (BAT-27). */
function ReturnReason({ stage }: { stage: TaskStage }) {
  const returned = stage.returnReason;
  if (!returned) return null;
  return (
    <div
      role="note"
      data-testid="return-reason"
      className="mt-3 rounded-md border border-amber-500/40 bg-amber-500/5 px-3 py-2 text-sm"
    >
      <p className="flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
        <UndoIcon className="size-3.5 text-amber-600 dark:text-amber-400" aria-hidden="true" />
        Sent back{returned.from ? ` from ${returned.from.name}` : ''} by
        <UserName user={returned.by} via={returned.via} avatar="xs" />
        <RelativeTime value={returned.at} />
      </p>
      <p className="mt-1 break-words whitespace-pre-wrap">{returned.reason}</p>
    </div>
  );
}

/**
 * The moves the viewer can make (BAT-27): a green button to the next stage (disabled, with what
 * is missing, while it is blocked) and an amber Send back… for the earlier stages it may go to.
 */
function StageMoves({
  stage,
  onMoveOn,
  moving,
  onSendBack,
}: {
  stage: TaskStage;
  onMoveOn?: (() => void) | undefined;
  moving?: boolean | undefined;
  onSendBack?: ((result: SendBackResult) => Promise<unknown>) | undefined;
}) {
  const [sending, setSending] = useState(false);
  const forward =
    stage.canMoveTo?.forward ??
    (stage.next ? { ...stage.next, missing: stage.canMove ? [] : stage.missing } : null);
  const back = onSendBack ? (stage.canMoveTo?.back ?? []) : [];
  if (!forward && back.length === 0) return null;
  const blocked = !forward || forward.missing.length > 0 || !onMoveOn;
  const moveButton = forward ? (
    <Button
      size="sm"
      onClick={onMoveOn}
      disabled={blocked || moving}
      data-testid="move-forward"
      className="bg-emerald-600 text-white hover:bg-emerald-600/90 dark:bg-emerald-600 dark:hover:bg-emerald-600/90"
    >
      {moving ? <Spinner /> : <ArrowRightIcon aria-hidden="true" />}
      Move to {forward.name}
    </Button>
  ) : null;
  return (
    <div className="mt-4 flex flex-wrap items-center gap-2">
      {forward && blocked && forward.missing.length > 0 ? (
        <Tooltip>
          <TooltipTrigger asChild>
            {/* A disabled button gets no pointer or focus events: the wrapper shows the reason. */}
            <span
              tabIndex={0}
              className="rounded-md"
              aria-label={`Move to ${forward.name}: blocked`}
            >
              {moveButton}
            </span>
          </TooltipTrigger>
          <TooltipContent className="max-w-xs">
            <p className="font-medium">Still needed:</p>
            <ul className="list-disc pl-4">
              {forward.missing.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          </TooltipContent>
        </Tooltip>
      ) : (
        moveButton
      )}
      {back.length > 0 && onSendBack ? (
        <>
          <Button
            size="sm"
            variant="outline"
            onClick={() => setSending(true)}
            className="border-amber-500/60 text-amber-700 hover:bg-amber-500/10 hover:text-amber-800 dark:text-amber-400 dark:hover:text-amber-300"
          >
            <UndoIcon aria-hidden="true" />
            Send back…
          </Button>
          <SendBackDialog
            open={sending}
            onOpenChange={setSending}
            from={stage.status.name}
            stages={back}
            onConfirm={onSendBack}
          />
        </>
      ) : null}
    </div>
  );
}

function PoolClaim({ task }: { task: Task & { stage: TaskStage } }) {
  const claim = useClaimAction(task);
  const pool = task.stage.pool;
  if (!pool) return null;
  return (
    <div className="mt-3 flex flex-wrap items-center gap-2 rounded-md border border-dashed px-3 py-2 text-sm">
      <HandIcon className="size-4 text-muted-foreground" aria-hidden="true" />
      <span>
        Claimable by <strong>{pool.rule}</strong>
      </span>
      {pool.canClaim ? (
        <Button
          size="sm"
          variant="outline"
          className="ml-auto"
          disabled={claim.isPending}
          onClick={() =>
            claim.mutateAsync({ kind: 'claim' }).then(
              () => toast.success('You claimed this task: it is assigned to you'),
              (error: unknown) => toast.error(errorMessage(error)),
            )
          }
        >
          {claim.isPending ? <Spinner /> : <HandIcon aria-hidden="true" />}
          Claim
        </Button>
      ) : null}
    </div>
  );
}

function CriterionState({ done }: { done: boolean }) {
  return done ? (
    <CircleCheckIcon
      className="mt-0.5 size-4 shrink-0 text-emerald-600 dark:text-emerald-400"
      aria-label="Done"
    />
  ) : (
    <CircleIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-label="Missing" />
  );
}

function EvidenceView({ criterion }: { criterion: StageCriterion }) {
  if (!criterion.evidence) {
    return <p className="text-xs text-muted-foreground">No evidence yet.</p>;
  }
  return (
    <div className="grid gap-0.5">
      <p className="text-sm break-words whitespace-pre-wrap">{criterion.evidence.text}</p>
      <p className="flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
        <UserName user={criterion.evidence.user} via={criterion.evidence.via} avatar="xs" />
        <RelativeTime value={criterion.evidence.updatedAt} />
      </p>
    </div>
  );
}

function Criteria({ task }: { task: Task & { stage: TaskStage } }) {
  const { stage } = task;
  const save = useSaveEvidence(task);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const done = stage.criteria.filter((criterion) => criterion.evidence).length;
  const changed = Object.entries(drafts).filter(
    ([id, text]) => text.trim() !== (stage.criteria.find((c) => c.id === id)?.evidence?.text ?? ''),
  );

  const submit = () => {
    setError(null);
    // Promise callbacks: saving may move the task on (auto-advance) and unmount this list.
    save.mutateAsync(Object.fromEntries(changed.map(([id, text]) => [id, text.trim()]))).then(
      (updated) => {
        setDrafts({});
        toast.success(
          updated.status.id !== task.status.id
            ? `Evidence saved: moved to ${updated.status.name}`
            : 'Evidence saved',
        );
      },
      (cause: unknown) => setError(errorMessage(cause)),
    );
  };

  return (
    <div className="mt-4">
      <h3 className="text-xs font-medium text-muted-foreground">
        Exit criteria ({done}/{stage.criteria.length})
      </h3>
      <ul className="mt-2 grid gap-3">
        {stage.criteria.map((criterion) => (
          <li key={criterion.id} className="flex items-start gap-2">
            <CriterionState done={Boolean(criterion.evidence)} />
            <div className="grid min-w-0 flex-1 gap-1">
              <p className="text-sm font-medium">{criterion.text}</p>
              {stage.canEditEvidence ? (
                <Textarea
                  value={drafts[criterion.id] ?? criterion.evidence?.text ?? ''}
                  onChange={(event) =>
                    setDrafts((current) => ({ ...current, [criterion.id]: event.target.value }))
                  }
                  aria-label={`Evidence for ${criterion.text}`}
                  placeholder="What was done: a summary, a link, test output…"
                  rows={2}
                  className="min-h-14 text-sm"
                />
              ) : (
                <EvidenceView criterion={criterion} />
              )}
              {stage.canEditEvidence && criterion.evidence ? (
                <p className="flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
                  <UserName
                    user={criterion.evidence.user}
                    via={criterion.evidence.via}
                    avatar="xs"
                  />
                  <RelativeTime value={criterion.evidence.updatedAt} />
                </p>
              ) : null}
            </div>
          </li>
        ))}
      </ul>
      {stage.canEditEvidence ? (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            variant="outline"
            onClick={submit}
            disabled={save.isPending || changed.length === 0}
          >
            {save.isPending ? <Spinner /> : <CheckIcon aria-hidden="true" />}
            Save evidence
          </Button>
          {error ? (
            <p role="alert" className="text-xs text-destructive">
              {error}
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function Approvals({ task }: { task: Task & { stage: TaskStage } }) {
  const approvals = task.stage.approvals;
  const decide = useDecideApproval(task);
  const [comment, setComment] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [requesting, setRequesting] = useState(false);
  if (!approvals) return null;
  // Where Request changes can send it (BAT-27): the reviewer picks the stage and the reason.
  const back = task.stage.canMoveTo?.back ?? (task.stage.sendBackTo ? [task.stage.sendBackTo] : []);

  const run = (decision: 'approve' | 'request_changes') => {
    setError(null);
    // Promise callbacks: a decision may move the task (auto-advance, send back) and unmount this.
    decide.mutateAsync({ decision, ...(comment.trim() ? { comment: comment.trim() } : {}) }).then(
      (updated) => {
        setComment('');
        toast.success(
          decision === 'approve'
            ? updated.status.id !== task.status.id
              ? `Approved: moved to ${updated.status.name}`
              : 'Approved'
            : updated.status.id !== task.status.id
              ? `Changes requested: sent back to ${updated.status.name}`
              : 'Changes requested',
        );
      },
      (cause: unknown) => setError(errorMessage(cause)),
    );
  };

  return (
    <div className="mt-4">
      <h3 className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
        <ShieldCheckIcon className="size-3.5" aria-hidden="true" />
        Approvals {approvals.approved}/{approvals.required}
        <span className="font-normal">from {approvals.rule}</span>
      </h3>
      {approvals.given.length > 0 ? (
        <ul className="mt-2 grid gap-2" aria-label="Approvals given">
          {approvals.given.map((item) => (
            <li key={item.id} className="flex items-start gap-2 text-sm">
              {item.decision === 'approve' ? (
                <CheckIcon
                  className="mt-0.5 size-4 shrink-0 text-emerald-600 dark:text-emerald-400"
                  aria-hidden="true"
                />
              ) : (
                <XIcon
                  className="mt-0.5 size-4 shrink-0 text-amber-600 dark:text-amber-400"
                  aria-hidden="true"
                />
              )}
              <div className="min-w-0">
                <p className="flex flex-wrap items-center gap-1">
                  <UserName user={item.user} via={item.via} avatar="xs" />
                  <span className="text-muted-foreground">
                    {item.decision === 'approve' ? 'approved' : 'requested changes'}
                  </span>
                  <RelativeTime value={item.createdAt} className="text-xs text-muted-foreground" />
                </p>
                {item.comment ? (
                  <p className="text-sm break-words whitespace-pre-wrap text-muted-foreground">
                    {item.comment}
                  </p>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-1 text-sm text-muted-foreground">No approvals yet.</p>
      )}
      {approvals.dismissOnChange ? (
        <p className="mt-1 text-xs text-muted-foreground">
          Editing the task or its evidence dismisses these approvals.
        </p>
      ) : null}
      {approvals.canApprove ? (
        <div className="mt-3 grid gap-2">
          <Textarea
            value={comment}
            onChange={(event) => setComment(event.target.value)}
            aria-label="Approval comment (optional)"
            placeholder="Comment (optional): what you checked, or what has to change"
            rows={2}
            className="min-h-14 text-sm"
          />
          <div className="flex flex-wrap gap-2">
            <Button size="sm" onClick={() => run('approve')} disabled={decide.isPending}>
              {decide.isPending ? <Spinner /> : <CheckIcon aria-hidden="true" />}
              Approve
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => (back.length > 0 ? setRequesting(true) : run('request_changes'))}
              disabled={decide.isPending}
              className="border-amber-500/60 text-amber-700 hover:bg-amber-500/10 hover:text-amber-800 dark:text-amber-400 dark:hover:text-amber-300"
            >
              <UndoIcon aria-hidden="true" />
              Request changes{back.length > 0 ? '…' : ''}
              {back[0] ? (
                <span className="sr-only"> (sends it back to an earlier stage)</span>
              ) : null}
            </Button>
          </div>
          <SendBackDialog
            open={requesting}
            onOpenChange={setRequesting}
            from={task.stage.status.name}
            stages={back}
            initialReason={comment}
            title="Request changes"
            confirmLabel="Request changes, send back"
            onConfirm={({ statusId, reason }) =>
              decide
                .mutateAsync({ decision: 'request_changes', comment: reason, sendBackTo: statusId })
                .then((updated) => {
                  setComment('');
                  toast.success(`Changes requested: sent back to ${updated.status.name}`);
                })
            }
          />
          {error ? (
            <p role="alert" className="text-xs text-destructive">
              {error}
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/** What reviewers said in earlier stages (their comments stay visible after the task moves on). */
function PreviousReviews({ stage }: { stage: TaskStage }) {
  const groups = (stage.previousApprovals ?? [])
    .map((group) => ({
      ...group,
      decisions: group.decisions.filter((decision) => decision.comment?.trim()),
    }))
    .filter((group) => group.decisions.length > 0);
  if (groups.length === 0) return null;
  return (
    <div className="mt-4 border-t pt-3">
      <h3 className="mb-2 text-xs font-medium text-muted-foreground">
        Reviews from earlier stages and visits
      </h3>
      <ul className="grid gap-2" aria-label="Reviews from earlier stages">
        {groups.flatMap((group) =>
          group.decisions.map((decision) => (
            <li key={decision.id} className="rounded-md bg-muted/50 px-3 py-2 text-sm">
              <p className="text-xs text-muted-foreground">
                @{decision.user?.username ?? 'someone'}{' '}
                {decision.decision === 'approve' ? 'approved' : 'requested changes'} in{' '}
                {group.status.name}
                {group.status.id === stage.status.id ? ' (a previous visit)' : ''}
              </p>
              <p className="whitespace-pre-wrap">{decision.comment}</p>
            </li>
          )),
        )}
      </ul>
    </div>
  );
}

function PreviousEvidence({ stage }: { stage: TaskStage }) {
  const [open, setOpen] = useState(false);
  return (
    <Collapsible open={open} onOpenChange={setOpen} className="mt-4 border-t pt-3">
      <CollapsibleTrigger asChild>
        <Button variant="ghost" size="sm" className="-ml-2 h-7 text-xs text-muted-foreground">
          <ChevronRightIcon
            className={cn('transition-transform', open && 'rotate-90')}
            aria-hidden="true"
          />
          Evidence from earlier stages and visits
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="mt-2 grid gap-3">
          {stage.previousEvidence.map((group) => (
            <Section
              key={`${group.status.id}:${group.visit?.enteredAt ?? ''}`}
              title={
                group.status.id === stage.status.id
                  ? `${group.status.name}, a previous visit`
                  : group.status.name
              }
            >
              <ul className="grid gap-2">
                {group.criteria.map((criterion) => (
                  <li key={criterion.id} className="flex items-start gap-2">
                    <CriterionState done={Boolean(criterion.evidence)} />
                    <div className="min-w-0">
                      <p className="text-sm font-medium">{criterion.text}</p>
                      <EvidenceView criterion={criterion} />
                    </div>
                  </li>
                ))}
              </ul>
            </Section>
          ))}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div>
      <h4 className="mb-1 text-xs font-medium text-muted-foreground">{title} (locked)</h4>
      {children}
    </div>
  );
}

/** Every visit of the task to a stage, oldest first (BAT-27), with why it came back. */
function StageHistory({ stage }: { stage: TaskStage }) {
  const [open, setOpen] = useState(false);
  const visits = stage.visits ?? [];
  return (
    <Collapsible open={open} onOpenChange={setOpen} className="mt-4 border-t pt-3">
      <CollapsibleTrigger asChild>
        <Button variant="ghost" size="sm" className="-ml-2 h-7 text-xs text-muted-foreground">
          <ChevronRightIcon
            className={cn('transition-transform', open && 'rotate-90')}
            aria-hidden="true"
          />
          <HistoryIcon aria-hidden="true" />
          Stage history ({visits.length} visits)
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <ol className="mt-2 grid gap-2" aria-label="Stage history" data-testid="stage-history">
          {visits.map((visit) => (
            <li key={visit.id} className="grid gap-0.5 text-sm">
              <p className="flex flex-wrap items-center gap-1">
                <span className="font-medium">{visit.status.name}</span>
                <RelativeTime value={visit.enteredAt} className="text-xs text-muted-foreground" />
                {visit.leftAt ? null : <span className="text-xs text-muted-foreground">(now)</span>}
              </p>
              {visit.returnReason ? (
                <p className="text-xs break-words whitespace-pre-wrap text-muted-foreground">
                  Sent back{visit.returnedFrom ? ` from ${visit.returnedFrom.name}` : ''}:{' '}
                  {visit.returnReason}
                </p>
              ) : null}
            </li>
          ))}
        </ol>
      </CollapsibleContent>
    </Collapsible>
  );
}
