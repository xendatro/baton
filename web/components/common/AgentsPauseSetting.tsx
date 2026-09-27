import { BotIcon } from 'lucide-react';
import { useId } from 'react';
import { Switch } from '@web/components/ui/switch';
import { cn } from '@web/lib/utils';
import { RelativeTime } from './RelativeTime';

export interface AgentsPauseSettingProps {
  /** Where the switch applies: "team" or "project". */
  scope: 'team' | 'project';
  /** When all agents were paused here, or null. */
  pausedAt: string | null | undefined;
  /** The viewer may change it (`MANAGE_TEAM` / `MANAGE_PROJECTS`). */
  canManage: boolean;
  /** The permission it needs, for the hint shown to others ("Manage team"). */
  permissionLabel: string;
  pending?: boolean;
  onChange: (paused: boolean) => void;
  className?: string;
}

/**
 * "Pause all agents" (docs/design/agents-and-pipelines.md §1): a kill switch that refuses every
 * agent member's writes in a team or project, with since when it has been paused.
 */
export function AgentsPauseSetting({
  scope,
  pausedAt,
  canManage,
  permissionLabel,
  pending = false,
  onChange,
  className,
}: AgentsPauseSettingProps) {
  const id = useId();
  const hintId = useId();
  return (
    <div
      className={cn(
        'flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between',
        className,
      )}
    >
      <div className="flex min-w-0 items-start gap-3">
        <BotIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        <div className="min-w-0 space-y-0.5">
          <label htmlFor={id} className="text-sm font-medium">
            Pause all agents
          </label>
          <p id={hintId} className="text-sm text-muted-foreground">
            Agents can still read, but everything they try to change in this {scope} is refused.
            {pausedAt ? (
              <>
                {' '}
                <span className="font-medium text-foreground">
                  Paused <RelativeTime value={pausedAt} />.
                </span>
              </>
            ) : null}
            {canManage ? null : ` Changing it needs the ${permissionLabel} permission.`}
          </p>
        </div>
      </div>
      <Switch
        id={id}
        aria-describedby={hintId}
        checked={Boolean(pausedAt)}
        disabled={!canManage || pending}
        onCheckedChange={onChange}
        className="shrink-0"
      />
    </div>
  );
}
