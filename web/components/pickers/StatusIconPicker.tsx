import { STATUS_ICONS, type StatusIconShape } from '@shared/constants';
import { StatusIcon } from '@web/components/common/StatusBadge';
import { STATUS_ICON_SHAPES } from '@web/components/common/statusIcons';
import { Button } from '@web/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@web/components/ui/popover';
import { cn } from '@web/lib/utils';
import { ColorPanel } from './ColorPicker';
import type { PickerControlProps } from './PickerShell';
import { useOpenState } from './useOpenState';

export interface StatusIconValue {
  icon: StatusIconShape;
  /** `#rrggbb`. */
  color: string;
}

export interface StatusIconPickerProps extends PickerControlProps {
  value: StatusIconValue;
  /** Called with what changed (the shape or the color); the popover stays open to mix both. */
  onChange: (change: Partial<StatusIconValue>) => void;
  /** Accessible name of the default trigger, e.g. "Done icon". */
  label?: string;
}

/**
 * A status's icon: a grid of shapes drawn in the current color, and the color palette (plus a
 * hex input) below. Shape and color are picked independently.
 */
export function StatusIconPicker({
  value,
  onChange,
  label = 'Icon',
  open,
  onOpenChange,
  disabled,
  children,
  align = 'start',
}: StatusIconPickerProps) {
  const [isOpen, setOpen] = useOpenState(open, onOpenChange);
  const shapeName = STATUS_ICON_SHAPES[value.icon].label;
  const trigger = children ?? (
    <Button
      variant="outline"
      size="icon-sm"
      disabled={disabled}
      aria-label={`${label}: ${shapeName}, ${value.color}`}
    >
      <StatusIcon status={{ name: label, ...value }} className="size-4" />
    </Button>
  );
  return (
    <Popover open={isOpen} onOpenChange={setOpen}>
      <PopoverTrigger asChild>{trigger}</PopoverTrigger>
      <PopoverContent className="w-64 p-3" align={align}>
        {isOpen ? (
          <div className="grid gap-3">
            <div>
              <p className="mb-2 text-xs font-medium text-muted-foreground">Shape</p>
              <div role="radiogroup" aria-label="Shape" className="grid grid-cols-6 gap-1">
                {STATUS_ICONS.map((icon) => {
                  const selected = icon === value.icon;
                  const { label: name } = STATUS_ICON_SHAPES[icon];
                  return (
                    <button
                      key={icon}
                      type="button"
                      role="radio"
                      aria-checked={selected}
                      aria-label={name}
                      title={name}
                      onClick={() => onChange({ icon })}
                      className={cn(
                        'flex size-8 items-center justify-center rounded-md outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring',
                        selected && 'bg-accent ring-1 ring-foreground/40',
                      )}
                    >
                      <StatusIcon status={{ name, icon, color: value.color }} className="size-4" />
                    </button>
                  );
                })}
              </div>
            </div>
            <div>
              <p className="mb-2 text-xs font-medium text-muted-foreground">Color</p>
              <ColorPanel
                key={value.color}
                value={value.color}
                onChange={(color) => onChange({ color })}
              />
            </div>
          </div>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}
