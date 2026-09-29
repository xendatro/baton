import { CircleAlertIcon } from 'lucide-react';
import { effortsFor, harnessOptionOf, stepAvailabilityOf } from '@shared/modelOptions';
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
 * One model step — harness, model, effort — as dropdowns of what the owner's computers report
 * (`GET /api/me/agent/model-options`; never a hardcoded list). A choice none of their computers
 * has shows in red with why ("You don’t have Codex set up on any of your computers"); callers
 * disable Approve / Run on it (`stepAvailabilityOf` in shared/modelOptions.ts). Harnesses of older desktop apps, which
 * don't report their models, take a typed model (unverified). Efforts fall back to a generic
 * list, labelled so, only when nothing reports any.
 */

/** Only when no computer reports efforts for the harness (labelled "generic" in the list). */
const GENERIC_EFFORTS = ['low', 'medium', 'high'];

const selectClass =
  'h-8 max-w-48 rounded-md border border-input bg-transparent px-2 text-sm dark:bg-input/30 aria-[invalid=true]:border-destructive aria-[invalid=true]:text-destructive';

export function ModelStepPicker({
  label,
  value,
  onChange,
  options,
  className,
  disabled,
  index,
}: {
  /** Accessible name prefix, e.g. "Run with". */
  label: string;
  /** The step's position in a chain (its fields are named "harness 1", "model 1", …). */
  index?: number;
  value: ChainEntry;
  onChange: (step: ChainEntry) => void;
  /** The owner's model options (undefined while loading). */
  options: ModelOptions | undefined;
  className?: string;
  disabled?: boolean;
}) {
  const at = index === undefined ? '' : ` ${index + 1}`;
  const harness = harnessOptionOf(options, value.harness);
  const availability = stepAvailabilityOf(options, value);
  const invalid = availability !== null && !availability.available;
  const reportedModels = harness?.reported ? harness.models : [];
  const modelListed =
    !value.model ||
    reportedModels.some((model) => model.id.toLowerCase() === value.model.toLowerCase());
  const efforts = effortsFor(harness, value.model);
  const generic = efforts.length === 0;
  const effortList = generic ? GENERIC_EFFORTS : efforts;
  const effortListed = !value.effort || effortList.includes(value.effort);
  const installed = HARNESS_IDS.filter((id) => harnessOptionOf(options, id));
  const missing = HARNESS_IDS.filter((id) => !harnessOptionOf(options, id));
  const setHarness = (id: HarnessId) => {
    const next = harnessOptionOf(options, id);
    // A new harness starts on its default model and effort.
    onChange({ harness: id, model: '', effort: next ? '' : value.effort });
  };
  return (
    <div className={cn('grid gap-1', className)}>
      <div className="flex flex-wrap items-center gap-1.5">
        <select
          aria-label={`${label}: harness${at}`}
          aria-invalid={invalid && !harness ? true : undefined}
          value={value.harness}
          disabled={disabled}
          onChange={(event) => setHarness(event.target.value as HarnessId)}
          className={selectClass}
        >
          {installed.length > 0 ? (
            <optgroup label="On your computers">
              {installed.map((id) => (
                <option key={id} value={id}>
                  {HARNESS_LABELS[id]}
                  {harnessOptionOf(options, id)?.online ? '' : ' (offline)'}
                </option>
              ))}
            </optgroup>
          ) : null}
          <optgroup label={installed.length > 0 ? 'Not set up on your computers' : 'Harnesses'}>
            {missing.map((id) => (
              <option key={id} value={id}>
                {HARNESS_LABELS[id]}
              </option>
            ))}
          </optgroup>
        </select>
        {harness && !harness.reported ? (
          // An older desktop app: it doesn't say which models it has.
          <Input
            aria-label={`${label}: model${at}`}
            value={value.model}
            disabled={disabled}
            onChange={(event) => onChange({ ...value, model: event.target.value })}
            placeholder="default model"
            maxLength={AGENT_RUNNER_LIMITS.model}
            className="h-8 w-36"
          />
        ) : (
          <select
            aria-label={`${label}: model${at}`}
            aria-invalid={invalid && !modelListed ? true : undefined}
            value={value.model}
            disabled={disabled}
            onChange={(event) => onChange({ ...value, model: event.target.value, effort: '' })}
            className={selectClass}
          >
            <option value="">Default model</option>
            {reportedModels.map((model) => (
              <option key={model.id} value={model.id}>
                {model.label && model.label !== model.id
                  ? `${model.label} (${model.id})`
                  : model.id}
                {model.online ? '' : ' (offline)'}
              </option>
            ))}
            {modelListed ? null : <option value={value.model}>{value.model} (not set up)</option>}
          </select>
        )}
        <select
          aria-label={`${label}: effort${at}`}
          aria-invalid={invalid && !effortListed ? true : undefined}
          value={value.effort}
          disabled={disabled}
          onChange={(event) => onChange({ ...value, effort: event.target.value })}
          className={selectClass}
        >
          <option value="">Default effort</option>
          <optgroup label={generic ? 'Generic (not reported by your computers)' : 'Efforts'}>
            {effortList.map((effort) => (
              <option key={effort} value={effort}>
                {effort}
              </option>
            ))}
          </optgroup>
          {effortListed ? null : <option value={value.effort}>{value.effort} (not set up)</option>}
        </select>
      </div>
      {invalid && availability.message ? (
        <p className="flex items-start gap-1 text-xs text-destructive" role="alert">
          <CircleAlertIcon className="mt-0.5 size-3 shrink-0" aria-hidden="true" />
          <span>{availability.message}</span>
        </p>
      ) : availability?.unverified ? (
        <p className="text-xs text-muted-foreground">
          Your desktop app doesn’t report {HARNESS_LABELS[value.harness]}’s models yet: update it to
          pick from a list.
        </p>
      ) : null}
    </div>
  );
}
