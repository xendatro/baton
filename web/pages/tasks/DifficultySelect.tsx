import { hardestFirst } from '@web/lib/difficulty';
import { cn } from '@web/lib/utils';

/**
 * A plain select of a project's difficulty levels (hardest first, BAT-30) and "No difficulty",
 * for the difficulty a move sets for the stage it goes to (BAT-28) and a stage's default.
 */

export interface DifficultyLevel {
  id: string;
  name: string;
}

export function DifficultySelect({
  id,
  levels,
  value,
  onChange,
  className,
}: {
  id: string;
  /** The project's levels, easiest first (as the API sends them). */
  levels: readonly DifficultyLevel[];
  value: string | null;
  onChange: (value: string | null) => void;
  className?: string;
}) {
  return (
    <select
      id={id}
      value={value ?? ''}
      onChange={(event) => onChange(event.target.value || null)}
      className={cn(
        'h-9 w-full rounded-md border border-input bg-transparent px-2 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:opacity-50 dark:bg-input/30',
        className,
      )}
    >
      <option value="">No difficulty</option>
      {hardestFirst(levels).map((level) => (
        <option key={level.id} value={level.id}>
          {level.name}
        </option>
      ))}
    </select>
  );
}
