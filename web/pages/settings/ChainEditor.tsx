import { ArrowDownIcon, ArrowUpIcon, CircleAlertIcon, PlusIcon, Trash2Icon } from 'lucide-react';
import { useId } from 'react';
import { canonicalModel } from '@shared/modelPrices';
import {
  AGENT_RUNNER_LIMITS,
  HARNESS_IDS,
  HARNESS_LABELS,
  type Chain,
  type ChainEntry,
  type HarnessId,
} from '@shared/schemas/agentRunner';
import { Button } from '@web/components/ui/button';
import { Input } from '@web/components/ui/input';
import { useModelFailures } from './automaticAgentsQueries';

/**
 * A model fallback chain editor (BAT-24): harness, model and effort per step, tried in order.
 * Used by Settings → Automatic agents (the default chain) and a project's Your settings (BAT-29).
 * When the latest run of an entry's harness and model failed, its error shows under the entry
 * ("Last run failed: …", BAT#23): that is how a model the harness rejects shows up, since model
 * lists are never hardcoded.
 */

/** Suggestions only: model lists are never hardcoded (free text always works). */
const MODEL_ALIASES: Partial<Record<HarnessId, string[]>> = {
  claude: ['opus', 'sonnet', 'haiku'],
};
const EFFORTS = ['low', 'medium', 'high', 'max'];

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
  const listId = useId();
  const failures = useModelFailures();
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
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="w-14 text-xs text-muted-foreground">
                  {index === 0 ? 'Run with' : 'then'}
                </span>
                <select
                  aria-label={`${label}: harness ${index + 1}`}
                  value={entry.harness}
                  onChange={(event) => set(index, { harness: event.target.value as HarnessId })}
                  className="h-8 rounded-md border border-input bg-transparent px-2 text-sm dark:bg-input/30"
                >
                  {HARNESS_IDS.map((harness) => (
                    <option key={harness} value={harness}>
                      {HARNESS_LABELS[harness]}
                    </option>
                  ))}
                </select>
                <Input
                  aria-label={`${label}: model ${index + 1}`}
                  value={entry.model}
                  onChange={(event) => set(index, { model: event.target.value })}
                  list={`${listId}-models-${entry.harness}`}
                  placeholder="default model"
                  maxLength={AGENT_RUNNER_LIMITS.model}
                  className="h-8 w-36"
                />
                <datalist id={`${listId}-models-${entry.harness}`}>
                  {(MODEL_ALIASES[entry.harness] ?? []).map((model) => (
                    <option key={model} value={model} />
                  ))}
                </datalist>
                <Input
                  aria-label={`${label}: effort ${index + 1}`}
                  value={entry.effort}
                  onChange={(event) => set(index, { effort: event.target.value })}
                  list={`${listId}-efforts`}
                  placeholder="effort"
                  maxLength={AGENT_RUNNER_LIMITS.effort}
                  className="h-8 w-24"
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
      <datalist id={`${listId}-efforts`}>
        {EFFORTS.map((effort) => (
          <option key={effort} value={effort} />
        ))}
      </datalist>
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
