import { Spinner } from '@web/components/common/Spinner';
import { Button } from '@web/components/ui/button';

export interface UnsavedChangesBarProps {
  /** The bar only shows while there are changes. */
  dirty: boolean;
  saving: boolean;
  /** Disables Save (e.g. while the form is invalid). */
  canSave?: boolean;
  onSave: () => void;
  onReset: () => void;
  message?: string;
}

/**
 * The Discord-style "unsaved changes" bar: pinned to the bottom of the viewport while a form has
 * changes, with Reset and Save.
 */
export function UnsavedChangesBar({
  dirty,
  saving,
  canSave = true,
  onSave,
  onReset,
  message = 'You have unsaved changes.',
}: UnsavedChangesBarProps) {
  if (!dirty) return null;
  return (
    <div className="sticky bottom-4 z-10 mt-6 flex animate-in justify-center duration-200 fade-in-0 slide-in-from-bottom-4">
      <div
        role="region"
        aria-label="Unsaved changes"
        className="flex w-full max-w-xl flex-wrap items-center justify-between gap-x-3 gap-y-2 rounded-lg border bg-popover px-4 py-2.5 text-popover-foreground shadow-lg"
      >
        <p className="text-sm font-medium">{message}</p>
        <div className="flex shrink-0 gap-2">
          <Button type="button" variant="ghost" size="sm" onClick={onReset} disabled={saving}>
            Reset
          </Button>
          <Button type="button" size="sm" onClick={onSave} disabled={saving || !canSave}>
            {saving ? <Spinner /> : null}
            Save changes
          </Button>
        </div>
      </div>
    </div>
  );
}
