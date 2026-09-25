import { Tooltip, TooltipContent, TooltipTrigger } from '@web/components/ui/tooltip';
import { Chip } from './Chip';

export interface LabelChipProps {
  label: { name: string; color: string; description?: string | null };
  className?: string;
}

export function LabelChip({ label, className }: LabelChipProps) {
  const chip = (
    <Chip color={label.color} className={className}>
      {label.name}
    </Chip>
  );
  if (!label.description) return chip;
  return (
    <Tooltip>
      <TooltipTrigger asChild>{chip}</TooltipTrigger>
      <TooltipContent>{label.description}</TooltipContent>
    </Tooltip>
  );
}
