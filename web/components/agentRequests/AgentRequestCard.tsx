import { CheckIcon, ExternalLinkIcon, HandIcon, XIcon } from 'lucide-react';
import { useId, useState } from 'react';
import { Link } from 'react-router';
import { toast } from 'sonner';
import type { AgentRequest } from '@shared/schemas/agentAccess';
import {
  DEFAULT_CHAIN,
  HARNESS_LABELS,
  type ChainEntry,
  type ModelOptions,
} from '@shared/schemas/agentRunner';
import { RelativeTime } from '@web/components/common/RelativeTime';
import { ranWithText } from '@web/lib/agentModels';
import { Spinner } from '@web/components/common/Spinner';
import { stepAvailabilityOf } from '@shared/modelOptions';
import { ModelStepPicker } from '@web/components/pickers/ModelStepPicker';
import { Badge } from '@web/components/ui/badge';
import { Button } from '@web/components/ui/button';
import { Checkbox } from '@web/components/ui/checkbox';
import { Label } from '@web/components/ui/label';
import { Textarea } from '@web/components/ui/textarea';
import { errorMessage } from '@web/lib/api';
import { cn } from '@web/lib/utils';
import { useApproveRequest, useDeclineRequest, useModelOptions } from './queries';

/**
 * A request to start the viewer's agent, as a card: the agent's question ("Can I reply to Caden’s
 * message here?"), who asked and when, the item and the message that asked (with links), and
 * **Approve** with **Run with** (harness, model and effort from what your computers report; it
 * starts from the requester's or stage's suggestion when you have it, else your default for the
 * project), the suggestion itself ("Caden suggests …"), or **Decline** with an optional reason the
 * requester sees. Used by the Requests page and, `compact`, inline in a conversation (only its
 * owner gets cards: `useAgentRequestsFor(item).mine`).
 */

function stepText(step: ChainEntry): string {
  return [HARNESS_LABELS[step.harness], step.model || null, step.effort || null]
    .filter(Boolean)
    .join(' · ');
}

const sameStep = (a: ChainEntry, b: ChainEntry) =>
  a.harness === b.harness && a.model === b.model && a.effort === b.effort;

export interface AgentRequestCardProps {
  request: AgentRequest;
  /** Inline in a conversation: no item line (you are on it), tighter spacing. */
  compact?: boolean;
  /** Bulk selection on the Requests page. */
  selected?: boolean;
  onSelectedChange?: (selected: boolean) => void;
  /** Model options (else loaded here). */
  options?: ModelOptions;
  className?: string;
}

export function AgentRequestCard({
  request,
  compact = false,
  selected,
  onSelectedChange,
  options,
  className,
}: AgentRequestCardProps) {
  const loaded = useModelOptions();
  const modelOptions = options ?? loaded.data;
  const suggested = request.suggestedChain[0] ??
    DEFAULT_CHAIN[0] ?? {
      harness: 'claude' as const,
      model: '',
      effort: '',
    };
  const [step, setStep] = useState<ChainEntry>(suggested);
  const [declining, setDeclining] = useState(false);
  const [reason, setReason] = useState('');
  const approve = useApproveRequest();
  const decline = useDeclineRequest();
  const reasonId = useId();
  const pending = request.status === 'pending';
  const availability = stepAvailabilityOf(modelOptions, step);
  const runnable = availability === null || availability.available;
  const busy = approve.isPending || decline.isPending;
  const who = request.requester?.name ?? 'Someone';
  const ref = request.target.ref ?? 'the item';

  const onApprove = () =>
    approve.mutate(
      // Unchanged: the mappings decide (with their fallbacks); a choice pins this model.
      { jobId: request.jobId, model: sameStep(step, suggested) ? null : step },
      {
        onSuccess: () =>
          toast.success(`Approved: ${request.agent.name} will ${lower(request.summary)}`),
        onError: (cause) => toast.error(errorMessage(cause)),
      },
    );
  const onDecline = () =>
    decline.mutate(
      { jobId: request.jobId, reason: reason.trim() || undefined },
      {
        onSuccess: () => {
          setDeclining(false);
          toast.success(`Declined ${who}’s request`);
        },
        onError: (cause) => toast.error(errorMessage(cause)),
      },
    );

  return (
    <article
      aria-label={`Request: ${request.summary}`}
      className={cn(
        'grid gap-3 rounded-lg border bg-card p-4 text-card-foreground',
        compact && 'gap-2 p-3',
        !pending && 'text-muted-foreground',
        className,
      )}
    >
      <header className="flex items-start gap-3">
        {onSelectedChange && pending ? (
          <Checkbox
            checked={selected ?? false}
            onCheckedChange={(value) => onSelectedChange(value === true)}
            aria-label={`Select: ${request.summary}`}
            className="mt-1"
          />
        ) : (
          <HandIcon className="mt-0.5 size-4 shrink-0 text-amber-600" aria-hidden="true" />
        )}
        <div className="min-w-0 flex-1">
          <p className="text-sm">
            <span className="font-medium">{request.agent.name}</span>
            <span className="text-muted-foreground"> asks </span>
            <span className="font-medium">“{request.question}”</span>
          </p>
          <p className="text-xs text-muted-foreground">
            {request.requester ? `@${request.requester.username} asked` : 'Asked'} ·{' '}
            <RelativeTime value={request.createdAt} />
            {request.stage ? ` · ${request.stage}` : ''}
            {!compact && request.project ? ` · ${request.project.name}` : ''}
          </p>
        </div>
        <StatusBadge request={request} />
      </header>

      {!compact && request.target.path ? (
        <p className="truncate text-sm">
          <Link to={request.target.path} className="font-medium hover:underline">
            {ref} {request.target.title}
          </Link>
        </p>
      ) : null}

      {request.message ? (
        <blockquote className="border-l-2 pl-3 text-sm break-words whitespace-pre-wrap text-muted-foreground">
          {excerpt(request.message.body)}
          {request.message.path ? (
            <>
              {' '}
              <Link
                to={request.message.path}
                className="inline-flex items-center gap-0.5 text-xs text-primary hover:underline"
              >
                <ExternalLinkIcon className="size-3" aria-hidden="true" />
                Open message
              </Link>
            </>
          ) : null}
        </blockquote>
      ) : null}

      <SuggestionLine request={request} options={modelOptions} />
      {pending ? (
        <div className="grid gap-2">
          <div className="flex flex-wrap items-start gap-2">
            <span className="mt-2 text-xs text-muted-foreground">Run with</span>
            <ModelStepPicker
              label={`Run with (${ref})`}
              value={step}
              onChange={setStep}
              options={modelOptions}
              disabled={busy}
            />
          </div>
          {sameStep(step, suggested) ? (
            <p className="text-xs text-muted-foreground">Starts from {request.suggestedSource}.</p>
          ) : null}
          {declining ? (
            <div className="grid gap-1.5">
              <Label htmlFor={reasonId} className="text-xs">
                Why not? (optional, {who} sees it)
              </Label>
              <Textarea
                id={reasonId}
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                maxLength={500}
                rows={2}
                placeholder="Not this week: ask @caden-ai instead"
              />
            </div>
          ) : null}
          <div className="flex flex-wrap gap-2">
            {declining ? (
              <>
                <Button
                  size="sm"
                  variant="destructive"
                  onClick={onDecline}
                  disabled={busy}
                  aria-label={`Confirm decline: ${request.summary}`}
                >
                  {decline.isPending ? <Spinner /> : <XIcon aria-hidden="true" />}
                  Decline
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setDeclining(false)}>
                  Cancel
                </Button>
              </>
            ) : (
              <>
                <Button
                  size="sm"
                  onClick={onApprove}
                  disabled={busy || !runnable}
                  aria-label={`Approve: ${request.summary}`}
                >
                  {approve.isPending ? <Spinner /> : <CheckIcon aria-hidden="true" />}
                  Approve
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => setDeclining(true)}
                  disabled={busy}
                  aria-label={`Decline: ${request.summary}`}
                >
                  <XIcon aria-hidden="true" />
                  Decline
                </Button>
              </>
            )}
          </div>
        </div>
      ) : (
        <DecidedLine request={request} />
      )}
    </article>
  );
}

function lower(text: string): string {
  return text.charAt(0).toLowerCase() + text.slice(1);
}

function excerpt(body: string): string {
  const text = body.trim();
  return text.length > 400 ? `${text.slice(0, 400)}…` : text;
}

const STATUS_LABELS: Record<AgentRequest['status'], string> = {
  pending: 'Waiting for you',
  approved: 'Approved',
  declined: 'Declined',
  cleared: 'Cleared',
};

function StatusBadge({ request }: { request: AgentRequest }) {
  return (
    <Badge variant={request.status === 'pending' ? 'default' : 'secondary'} className="shrink-0">
      {STATUS_LABELS[request.status]}
    </Badge>
  );
}

/** "Caden suggests Codex · gpt-6-sol · high" (or the stage), and whether you have it. */
function SuggestionLine({
  request,
  options,
}: {
  request: AgentRequest;
  options: ModelOptions | undefined;
}) {
  const model = request.suggestedModel;
  if (!model) return null;
  const who =
    request.suggestedModelFrom === 'stage'
      ? `The stage${request.stage ? ` ${request.stage}` : ''}`
      : (request.requester?.name ?? 'Someone');
  const availability = request.status === 'pending' ? stepAvailabilityOf(options, model) : null;
  return (
    <p className="text-xs text-muted-foreground" data-testid="request-suggestion">
      {who} suggests <span className="font-medium text-foreground">{stepText(model)}</span>
      {availability && !availability.available
        ? ` — ${availability.message ?? 'not on your computers'}, so it starts from your default.`
        : null}
    </p>
  );
}

function DecidedLine({ request }: { request: AgentRequest }) {
  const when = request.decidedAt ? (
    <>
      {' '}
      <RelativeTime value={request.decidedAt} />
    </>
  ) : null;
  if (request.status === 'approved') {
    const model = request.modelOverride?.[0];
    return (
      <p className="text-xs">
        Approved{when}
        {request.ranWith
          ? ` · ran with ${ranWithText(request.ranWith)}`
          : model
            ? ` · runs with ${stepText(model)}`
            : ` · runs with ${request.suggestedChain[0] ? stepText(request.suggestedChain[0]) : 'your default'}`}
      </p>
    );
  }
  if (request.status === 'declined') {
    return (
      <p className="text-xs">
        Declined{when}
        {request.reason ? `: “${request.reason}”` : ''}
      </p>
    );
  }
  return <p className="text-xs">Cleared{when}: its task or issue moved on meanwhile.</p>;
}
