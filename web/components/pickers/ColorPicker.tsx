import { CheckIcon } from 'lucide-react';
import { useId, useState } from 'react';
import { COLOR_PALETTE } from '@shared/constants';
import { hexColorSchema } from '@shared/schemas/common';
import { Button } from '@web/components/ui/button';
import { Input } from '@web/components/ui/input';
import { Label } from '@web/components/ui/label';
import { Popover, PopoverContent, PopoverTrigger } from '@web/components/ui/popover';
import { cn } from '@web/lib/utils';
import type { PickerControlProps } from './PickerShell';
import { useOpenState } from './useOpenState';

export interface ColorPickerProps extends PickerControlProps {
  /** `#rrggbb`. */
  value: string;
  onChange: (color: string) => void;
  /** Accessible name of the default trigger. */
  label?: string;
}

/** The 12-color palette plus a hex input for anything else. */
export function ColorPicker({
  value,
  onChange,
  label = 'Color',
  open,
  onOpenChange,
  disabled,
  children,
  align = 'start',
}: ColorPickerProps) {
  const [isOpen, setOpen] = useOpenState(open, onOpenChange);
  const trigger = children ?? (
    <Button variant="outline" size="icon-sm" disabled={disabled} aria-label={`${label}: ${value}`}>
      <span className="size-4 rounded-full border" style={{ backgroundColor: value }} />
    </Button>
  );
  return (
    <Popover open={isOpen} onOpenChange={setOpen}>
      <PopoverTrigger asChild>{trigger}</PopoverTrigger>
      <PopoverContent className="w-60 p-3" align={align}>
        {isOpen ? (
          <ColorPanel
            value={value}
            onChange={(color) => {
              onChange(color);
              setOpen(false);
            }}
          />
        ) : null}
      </PopoverContent>
    </Popover>
  );
}

function ColorPanel({ value, onChange }: { value: string; onChange: (color: string) => void }) {
  const inputId = useId();
  const [hex, setHex] = useState(value);
  const [error, setError] = useState<string | null>(null);

  const submitHex = () => {
    const withHash = hex.startsWith('#') ? hex : `#${hex}`;
    const parsed = hexColorSchema.safeParse(withHash);
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? 'Invalid color');
      return;
    }
    setError(null);
    onChange(parsed.data);
  };

  return (
    <div className="grid gap-3">
      <div role="radiogroup" aria-label="Palette" className="grid grid-cols-6 gap-2">
        {COLOR_PALETTE.map((color) => {
          const selected = color.hex === value.toLowerCase();
          return (
            <button
              key={color.hex}
              type="button"
              role="radio"
              aria-checked={selected}
              aria-label={color.name}
              title={color.name}
              onClick={() => onChange(color.hex)}
              className={cn(
                'flex size-7 items-center justify-center rounded-full ring-offset-2 ring-offset-popover outline-none focus-visible:ring-2 focus-visible:ring-ring',
                selected && 'ring-2 ring-foreground/60',
              )}
              style={{ backgroundColor: color.hex }}
            >
              {selected ? <CheckIcon className="size-4 text-white" aria-hidden="true" /> : null}
            </button>
          );
        })}
      </div>
      <form
        className="grid gap-1.5"
        onSubmit={(event) => {
          event.preventDefault();
          submitHex();
        }}
      >
        <Label htmlFor={inputId} className="text-xs text-muted-foreground">
          Custom hex
        </Label>
        <div className="flex gap-2">
          <Input
            id={inputId}
            value={hex}
            onChange={(event) => setHex(event.target.value)}
            placeholder="#6366f1"
            maxLength={7}
            className="h-8 font-mono"
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? `${inputId}-error` : undefined}
          />
          <Button type="submit" size="sm" variant="secondary">
            Set
          </Button>
        </div>
        {error ? (
          <p id={`${inputId}-error`} className="text-xs text-destructive">
            {error}
          </p>
        ) : null}
      </form>
    </div>
  );
}
