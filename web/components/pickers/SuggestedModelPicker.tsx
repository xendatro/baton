import { useId } from 'react';
import { effortsFor, harnessOptionOf } from '@shared/modelOptions';
import {
  AGENT_RUNNER_LIMITS,
  HARNESS_IDS,
  HARNESS_LABELS,
  type ChainEntry,
  type HarnessId,
  type ModelOptions,
} from '@shared/schemas/agentRunner';
import { Input } from '@web/components/ui/input';
import { cn } from '@web/lib/utils';

/**
 * A suggested model — harness, model, effort — or none. Unlike `ModelStepPicker` (the owner's own
 * computers), a suggestion is for someone else's agent: the lists come from the models the team's
 * computers report (`useSuggestableModels`), any value may be typed, and nothing shows as
 * missing; each owner's agent runs it only when one of their computers has it.
 */

const selectClass =
  'h-8 max-w-48 rounded-md border border-input bg-transparent px-2 text-sm dark:bg-input/30';

export function SuggestedModelPicker({
  label,
  value,
  onChange,
  options,
  disabled,
  className,
}: {
  /** Accessible name prefix, e.g. "Suggested model". */
  label: string;
  value: ChainEntry | null;
  onChange: (value: ChainEntry | null) => void;
  /** Models known to the team's computers (undefined while loading). */
  options: ModelOptions | undefined;
  disabled?: boolean;
  className?: string;
}) {
  const id = useId();
  const harness = value ? harnessOptionOf(options, value.harness) : null;
  const models = harness?.models ?? [];
  const efforts = value ? effortsFor(harness, value.model) : [];
  return (
    <div className={cn('flex flex-wrap items-center gap-1.5', className)}>
      <select
        aria-label={`${label}: harness`}
        value={value?.harness ?? ''}
        disabled={disabled}
        onChange={(event) => {
          const next = event.target.value;
          onChange(next ? { harness: next as HarnessId, model: '', effort: '' } : null);
        }}
        className={selectClass}
      >
        <option value="">No suggestion</option>
        {HARNESS_IDS.map((harnessId) => (
          <option key={harnessId} value={harnessId}>
            {HARNESS_LABELS[harnessId]}
          </option>
        ))}
      </select>
      {value ? (
        <>
          <Input
            aria-label={`${label}: model`}
            list={`${id}-models`}
            value={value.model}
            disabled={disabled}
            onChange={(event) => onChange({ ...value, model: event.target.value })}
            placeholder="default model"
            maxLength={AGENT_RUNNER_LIMITS.model}
            className="h-8 w-40"
          />
          <datalist id={`${id}-models`}>
            {models.map((model) => (
              <option key={model.id} value={model.id}>
                {model.label && model.label !== model.id ? model.label : undefined}
              </option>
            ))}
          </datalist>
          <Input
            aria-label={`${label}: effort`}
            list={`${id}-efforts`}
            value={value.effort}
            disabled={disabled}
            onChange={(event) => onChange({ ...value, effort: event.target.value })}
            placeholder="default effort"
            maxLength={AGENT_RUNNER_LIMITS.effort}
            className="h-8 w-28"
          />
          <datalist id={`${id}-efforts`}>
            {efforts.map((effort) => (
              <option key={effort} value={effort} />
            ))}
          </datalist>
        </>
      ) : null}
    </div>
  );
}
