import { CheckIcon, HandIcon, SettingsIcon, XIcon } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router';
import { toast } from 'sonner';
import { AgentRequestCard } from '@web/components/agentRequests/AgentRequestCard';
import {
  useAgentRequests,
  useDecideRequests,
  useModelOptions,
} from '@web/components/agentRequests/queries';
import { EmptyState } from '@web/components/common/EmptyState';
import { ErrorState } from '@web/components/common/ErrorState';
import { PageContainer } from '@web/components/common/PageContainer';
import { PageHeader } from '@web/components/common/PageHeader';
import { Button } from '@web/components/ui/button';
import { Checkbox } from '@web/components/ui/checkbox';
import { Skeleton } from '@web/components/ui/skeleton';
import { errorMessage } from '@web/lib/api';
import { pluralize } from '@web/lib/format';
import { useDocumentTitle } from '@web/lib/title';

/**
 * `/agent/requests`: people who may only *ask* want your agent to do something (agent access).
 * Each request is a card with Approve (choosing the model it runs with) or Decline (with an
 * optional reason); several can be decided at once. Decided ones stay listed for a day.
 */
export default function RequestsPage() {
  useDocumentTitle(['Requests']);
  const requests = useAgentRequests();
  const options = useModelOptions();
  const decide = useDecideRequests();
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const pending = requests.data?.filter((request) => request.status === 'pending') ?? [];
  const decided = requests.data?.filter((request) => request.status !== 'pending') ?? [];
  const chosen = pending.filter((request) => selected.has(request.jobId));

  const toggle = (jobId: string, on: boolean) =>
    setSelected((current) => {
      const next = new Set(current);
      if (on) next.add(jobId);
      else next.delete(jobId);
      return next;
    });
  const bulk = (decision: 'approve' | 'decline') =>
    decide.mutate(
      { jobIds: chosen.map((request) => request.jobId), decision },
      {
        onSuccess: (result) => {
          setSelected(new Set());
          const count = result.requests.length;
          toast.success(
            `${decision === 'approve' ? 'Approved' : 'Declined'} ${pluralize(count, 'request')}`,
          );
        },
        onError: (cause) => toast.error(errorMessage(cause)),
      },
    );

  return (
    <PageContainer>
      <PageHeader
        title="Requests"
        description="People who can ask you want your agent to do something. Approve to run it (and pick the model), or decline."
        actions={
          <Button asChild variant="outline" size="sm">
            <Link to="/settings/automatic-agents#who-can-start">
              <SettingsIcon aria-hidden="true" />
              Who can start your agent
            </Link>
          </Button>
        }
      />
      {requests.isPending ? (
        <div className="grid gap-3" aria-label="Loading requests">
          <Skeleton className="h-40 rounded-lg" />
          <Skeleton className="h-40 rounded-lg" />
        </div>
      ) : requests.isError ? (
        <ErrorState
          title="Couldn’t load your requests"
          error={requests.error}
          onRetry={() => void requests.refetch()}
        />
      ) : (
        <div className="grid gap-6">
          {pending.length === 0 ? (
            <EmptyState
              icon={HandIcon}
              title="No requests"
              description="When someone who may only ask mentions or assigns your agent, their request waits here for you."
              action={
                <Button asChild variant="outline">
                  <Link to="/settings/automatic-agents#who-can-start">
                    Who can start your agent
                  </Link>
                </Button>
              }
            />
          ) : (
            <section aria-label="Waiting for you" className="grid gap-3">
              <div className="flex flex-wrap items-center gap-2">
                <Checkbox
                  checked={
                    chosen.length === pending.length
                      ? true
                      : chosen.length > 0
                        ? 'indeterminate'
                        : false
                  }
                  onCheckedChange={(value) =>
                    setSelected(
                      value === true ? new Set(pending.map((request) => request.jobId)) : new Set(),
                    )
                  }
                  aria-label="Select all requests"
                />
                <h2 className="text-sm font-medium">Waiting for you ({pending.length})</h2>
                {chosen.length > 0 ? (
                  <div className="ml-auto flex gap-2">
                    <Button size="sm" onClick={() => bulk('approve')} disabled={decide.isPending}>
                      <CheckIcon aria-hidden="true" />
                      Approve {chosen.length}
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => bulk('decline')}
                      disabled={decide.isPending}
                    >
                      <XIcon aria-hidden="true" />
                      Decline {chosen.length}
                    </Button>
                  </div>
                ) : null}
              </div>
              {chosen.length > 0 ? (
                <p className="text-xs text-muted-foreground">
                  Approving several at once runs each with your models for its project.
                </p>
              ) : null}
              {pending.map((request) => (
                <AgentRequestCard
                  key={request.jobId}
                  request={request}
                  options={options.data}
                  selected={selected.has(request.jobId)}
                  onSelectedChange={(on) => toggle(request.jobId, on)}
                />
              ))}
            </section>
          )}
          {decided.length > 0 ? (
            <section aria-label="Recently decided" className="grid gap-3">
              <h2 className="text-sm font-medium text-muted-foreground">
                Recently decided ({decided.length})
              </h2>
              {decided.map((request) => (
                <AgentRequestCard key={request.jobId} request={request} options={options.data} />
              ))}
            </section>
          ) : null}
        </div>
      )}
    </PageContainer>
  );
}
