import { addDays, nextMonday } from 'date-fns';
import { CalendarIcon, XIcon } from 'lucide-react';
import { Button } from '@web/components/ui/button';
import { Calendar } from '@web/components/ui/calendar';
import { Popover, PopoverContent, PopoverTrigger } from '@web/components/ui/popover';
import { formatDueDate, parseDueDate, toDueDate } from '@web/lib/format';
import type { PickerControlProps } from './PickerShell';
import { useOpenState } from './useOpenState';

export interface DatePickerProps extends PickerControlProps {
  /** `YYYY-MM-DD` or null. */
  value: string | null;
  onChange: (value: string | null) => void;
  placeholder?: string;
}

const QUICK_PICKS: ReadonlyArray<{ label: string; date: (today: Date) => Date }> = [
  { label: 'Today', date: (today) => today },
  { label: 'Tomorrow', date: (today) => addDays(today, 1) },
  { label: 'Next week', date: (today) => nextMonday(today) },
  { label: 'In 2 weeks', date: (today) => addDays(today, 14) },
];

/** Calendar date picker with quick picks and a clear button. */
export function DatePicker({
  value,
  onChange,
  placeholder = 'Due date',
  open,
  onOpenChange,
  disabled,
  children,
  align = 'start',
}: DatePickerProps) {
  const [isOpen, setOpen] = useOpenState(open, onOpenChange);
  const selected = value ? parseDueDate(value) : undefined;

  const choose = (date: Date | undefined) => {
    onChange(date ? toDueDate(date) : null);
    setOpen(false);
  };

  const trigger = children ?? (
    <Button
      variant="outline"
      size="sm"
      disabled={disabled}
      className={value ? undefined : 'text-muted-foreground'}
      aria-label={
        value ? `${placeholder}: ${formatDueDate(value)}` : `Set ${placeholder.toLowerCase()}`
      }
    >
      <CalendarIcon aria-hidden="true" />
      {value ? formatDueDate(value) : placeholder}
    </Button>
  );

  return (
    <Popover open={isOpen} onOpenChange={setOpen}>
      <PopoverTrigger asChild>{trigger}</PopoverTrigger>
      <PopoverContent className="w-auto p-0" align={align}>
        <div className="flex flex-wrap gap-1 border-b p-2">
          {QUICK_PICKS.map((pick) => (
            <Button
              key={pick.label}
              variant="ghost"
              size="xs"
              onClick={() => choose(pick.date(new Date()))}
            >
              {pick.label}
            </Button>
          ))}
        </div>
        <Calendar
          mode="single"
          selected={selected}
          defaultMonth={selected}
          onSelect={choose}
          autoFocus
        />
        {value ? (
          <div className="border-t p-2">
            <Button
              variant="ghost"
              size="sm"
              className="w-full text-muted-foreground"
              onClick={() => choose(undefined)}
            >
              <XIcon aria-hidden="true" />
              Clear date
            </Button>
          </div>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}
