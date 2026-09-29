import { ChevronDownIcon, CpuIcon, XIcon } from 'lucide-react';
import { useState } from 'react';
import { stepLabel } from '@shared/agentChains';
import type { ChainEntry } from '@shared/schemas/agentRunner';
import { SuggestedModelPicker } from '@web/components/pickers/SuggestedModelPicker';
import { Button } from '@web/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@web/components/ui/popover';
import { useSuggestableModels } from '@web/lib/agentModels';

/**
 * "Suggest model" beside the reply composer when the draft @-mentions an agent: a model to suggest
 * for the run the reply starts ("with Codex · gpt-6-sol · high"), sent as the reply's
 * `suggestedModel`. Only a suggestion: the agent's owner runs it when one of their computers has
 * it (else their default), and approving a request they pick the model themselves.
 */

export function SuggestModelChip({
  projectId,
  value,
  onChange,
}: {
  projectId: string;
  value: ChainEntry | null;
  onChange: (value: ChainEntry | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const options = useSuggestableModels(projectId, open || value !== null);
  return (
    <div className="inline-flex items-center" data-testid="suggest-model">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-7 gap-1 rounded-full px-2.5 text-xs"
            title="Suggest a model for the agent’s run (only a suggestion)"
          >
            <CpuIcon aria-hidden="true" />
            {value ? `with ${stepLabel(value)}` : 'Suggest model'}
            <ChevronDownIcon aria-hidden="true" />
          </Button>
        </PopoverTrigger>
        <PopoverContent align="start" className="grid w-auto max-w-[min(32rem,90vw)] gap-2">
          <p className="text-sm font-medium">Suggest a model</p>
          <SuggestedModelPicker
            label="Suggested model"
            value={value}
            onChange={onChange}
            options={options.data}
          />
          <p className="text-xs text-muted-foreground">
            Only a suggestion: the agent’s owner runs it when one of their computers has it, else
            their own default.
          </p>
        </PopoverContent>
      </Popover>
      {value ? (
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label="Remove the suggested model"
          onClick={() => onChange(null)}
        >
          <XIcon aria-hidden="true" />
        </Button>
      ) : null}
    </div>
  );
}
