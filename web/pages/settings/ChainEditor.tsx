import { ArrowDownIcon, ArrowUpIcon, CircleAlertIcon, PlusIcon, Trash2Icon } from 'lucide-react';
import { canonicalModel } from '@shared/modelPrices';
import { AGENT_RUNNER_LIMITS, type Chain, type ChainEntry } from '@shared/schemas/agentRunner';
import { useModelOptions } from '@web/components/agentRequests/queries';
import { ModelStepPicker } from '@web/components/pickers/ModelStepPicker';
import { Button } from '@web/components/ui/button';
import { useModelFailures } from './automaticAgentsQueries';

/**
 * A model fallback chain editor (BAT-24): harness, model and effort per step, tried in order.
 * Used by Settings → Automatic agents (the default chain) and a project's Your settings (BAT-29).
 * When the latest run of an entry's harness and model failed, its error shows under the entry
 * ("Last run failed: …", BAT#23). Each step picks from what the owner's computers report
 * (`ModelStepPicker`); a step none of them can run shows in red.
 */

export function ChainEditor({
  label,
  value,
  onChange,
  emptyText,
}: {
  label: string;
  value: Chain;
  onChange: (chain: Chain) => void;
  /** Shown when empty (e.g. "Uses Normal (closest mapped level)"). */
  emptyText?: string;
}) {
  const failures = useModelFailures();
  // Harness, model and effort come from what your computers report (never hardcoded).
  const options = useModelOptions();
  const failureOf = (entry: ChainEntry) =>
    failures.data?.find(
      (failure) =>
        failure.harness === entry.harness && failure.model === canonicalModel(entry.model),
    ) ?? null;
  const set = (index: number, patch: Partial<ChainEntry>) =>
    onChange(value.map((entry, at) => (at === index ? { ...entry, ...patch } : entry)));
  const move = (index: number, by: -1 | 1) => {
    const next = [...value];
    const [entry] = next.splice(index, 1);
    if (entry) next.splice(index + by, 0, entry);
    onChange(next);
  };
  return (
    <div className="grid gap-1.5" role="group" aria-label={label}>
      {value.length === 0 && emptyText ? (
        <p className="text-sm text-muted-foreground">{emptyText}</p>
      ) : null}
      <ol className="grid gap-1.5">
        {value.map((entry, index) => {
          const failure = failureOf(entry);
          return (
            <li key={index} className="grid gap-0.5">
              <div className="flex flex-wrap items-start gap-1.5">
                <span className="mt-2 w-14 text-xs text-muted-foreground">
                  {index === 0 ? 'Run with' : 'then'}
                </span>
                <ModelStepPicker
                  label={label}
                  index={index}
                  value={entry}
                  onChange={(step) => set(index, step)}
                  options={options.data}
                />
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`Move step ${index + 1} up`}
                  disabled={index === 0}
                  onClick={() => move(index, -1)}
                >
                  <ArrowUpIcon aria-hidden="true" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`Move step ${index + 1} down`}
                  disabled={index === value.length - 1}
                  onClick={() => move(index, 1)}
                >
                  <ArrowDownIcon aria-hidden="true" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`Remove step ${index + 1}`}
                  onClick={() => onChange(value.filter((_, at) => at !== index))}
                >
                  <Trash2Icon aria-hidden="true" />
                </Button>
              </div>
              {failure ? (
                <p className="flex items-start gap-1 pl-15 text-xs text-destructive" role="note">
                  <CircleAlertIcon className="mt-0.5 size-3 shrink-0" aria-hidden="true" />
                  <span>Last run failed: {failure.error}</span>
                </p>
              ) : null}
            </li>
          );
        })}
      </ol>
      <Button
        variant="outline"
        size="sm"
        className="justify-self-start"
        disabled={value.length >= AGENT_RUNNER_LIMITS.chain}
        onClick={() =>
          onChange([
            ...value,
            { harness: value.length === 0 ? 'claude' : 'codex', model: '', effort: '' },
          ])
        }
      >
        <PlusIcon aria-hidden="true" />
        {value.length === 0 ? 'Set a model' : 'Add a fallback'}
      </Button>
    </div>
  );
}
