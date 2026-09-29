import { BotIcon, HandIcon } from 'lucide-react';
import { setAccessList, type AgentAccessRules } from '@shared/schemas/agentAccess';
import { PrincipalRulePicker } from '@web/components/pickers/PrincipalRulePicker';
import type { PrincipalOptions } from '@web/components/pickers/principals';

/**
 * Who can start your agent (agent access): two lists of people and roles — **Start
 * automatically** and **Can ask you** (a request you approve). Each person or role is in one list
 * at most: adding them to one takes them out of the other. Anyone in neither can't start it; you
 * and your own agent always can. Used by Settings → Automatic agents (per team) and a project's
 * Your settings (its override).
 */
export function AgentAccessEditor({
  value,
  onChange,
  options,
  disabled,
  label = 'Who can start your agent',
}: {
  value: AgentAccessRules;
  onChange: (rules: AgentAccessRules) => void;
  options: PrincipalOptions;
  disabled?: boolean;
  label?: string;
}) {
  return (
    <div className="grid gap-4" role="group" aria-label={label}>
      <div className="grid gap-1.5">
        <p className="flex items-center gap-1.5 text-sm font-medium">
          <BotIcon className="size-4 text-muted-foreground" aria-hidden="true" />
          Start automatically
        </p>
        <p className="text-xs text-muted-foreground">
          Their mentions, assignments and hand-offs run your agent right away.
        </p>
        <PrincipalRulePicker
          label={`${label}: start automatically`}
          value={value.auto}
          onChange={(rule) => onChange(setAccessList(value, 'auto', rule))}
          options={options}
          disabled={disabled}
        />
      </div>
      <div className="grid gap-1.5">
        <p className="flex items-center gap-1.5 text-sm font-medium">
          <HandIcon className="size-4 text-muted-foreground" aria-hidden="true" />
          Can ask you
        </p>
        <p className="text-xs text-muted-foreground">
          Their jobs wait on your Requests page until you approve (and pick the model) or decline.
        </p>
        <PrincipalRulePicker
          label={`${label}: can ask you`}
          value={value.ask}
          onChange={(rule) => onChange(setAccessList(value, 'ask', rule))}
          options={options}
          disabled={disabled}
        />
      </div>
      <p className="text-xs text-muted-foreground">
        Anyone in neither list can’t start your agent: they are told so when they mention or assign
        it. You and your own agent always can. Someone added to one list leaves the other.
      </p>
    </div>
  );
}
