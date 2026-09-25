import { startOfMonth, subDays } from 'date-fns';
import { CalendarIcon, ChevronDownIcon } from 'lucide-react';
import { useState } from 'react';
import type { DateRange } from 'react-day-picker';
import { Button } from '@web/components/ui/button';
import { Calendar } from '@web/components/ui/calendar';
import { Popover, PopoverContent, PopoverTrigger } from '@web/components/ui/popover';
import { cn } from '@web/lib/utils';
import { describeRange, formatDay, parseDay } from './filters';

export interface DateRangeFilterProps {
  /** `YYYY-MM-DD` or null (inclusive). */
  from: string | null;
  to: string | null;
  onChange: (range: { from: string | null; to: string | null }) => void;
}

const PRESETS: ReadonlyArray<{ label: string; range: (today: Date) => [Date, Date] }> = [
  { label: 'Today', range: (today) => [today, today] },
  { label: 'Yesterday', range: (today) => [subDays(today, 1), subDays(today, 1)] },
  { label: 'Last 7 days', range: (today) => [subDays(today, 6), today] },
  { label: 'Last 30 days', range: (today) => [subDays(today, 29), today] },
  { label: 'This month', range: (today) => [startOfMonth(today), today] },
];

/** Date range filter: presets and a two-click range calendar (days in the viewer's time zone). */
export function DateRangeFilter({ from, to, onChange }: DateRangeFilterProps) {
  const [open, setOpen] = useState(false);
  const start = parseDay(from) ?? undefined;
  const end = parseDay(to) ?? undefined;
  const [draft, setDraft] = useState<DateRange | undefined>(undefined);
  const selected: DateRange | undefined =
    draft ?? (start || end ? { from: start, to: end } : undefined);
  const label = describeRange(from, to);
  const today = new Date();

  const apply = (range: DateRange | undefined) => {
    onChange({
      from: range?.from ? formatDay(range.from) : null,
      to: range?.to ? formatDay(range.to) : range?.from ? formatDay(range.from) : null,
    });
  };

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        setDraft(undefined);
      }}
    >
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className={cn(label && 'border-primary/40 bg-primary/5 dark:bg-primary/10')}
          aria-label={label ? `Date: ${label}` : 'Filter by date'}
        >
          <CalendarIcon aria-hidden="true" className="text-muted-foreground" />
          {label ? (
            <span>
              <span className="text-muted-foreground">Date: </span>
              {label}
            </span>
          ) : (
            <span className="text-muted-foreground">Date</span>
          )}
          <ChevronDownIcon aria-hidden="true" className="text-muted-foreground" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-auto p-0" align="start">
        <div className="flex flex-col sm:flex-row">
          <div className="flex flex-wrap gap-1 border-b p-2 sm:w-36 sm:flex-col sm:flex-nowrap sm:border-r sm:border-b-0">
            {PRESETS.map((preset) => (
              <Button
                key={preset.label}
                variant="ghost"
                size="sm"
                className="justify-start"
                onClick={() => {
                  const [presetFrom, presetTo] = preset.range(today);
                  apply({ from: presetFrom, to: presetTo });
                  setOpen(false);
                }}
              >
                {preset.label}
              </Button>
            ))}
            {label ? (
              <Button
                variant="ghost"
                size="sm"
                className="justify-start text-muted-foreground"
                onClick={() => {
                  apply(undefined);
                  setOpen(false);
                }}
              >
                Any time
              </Button>
            ) : null}
          </div>
          <Calendar
            mode="range"
            selected={selected}
            defaultMonth={start ?? today}
            disabled={{ after: today }}
            onSelect={(range, day) => {
              // First click starts a new range; the second completes it.
              if (!draft) {
                setDraft({ from: day, to: undefined });
                return;
              }
              const next = range?.from && range.to ? range : { from: day, to: day };
              setDraft(undefined);
              apply(next);
              setOpen(false);
            }}
          />
        </div>
      </PopoverContent>
    </Popover>
  );
}
