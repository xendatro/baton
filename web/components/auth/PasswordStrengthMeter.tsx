import { cn } from '@web/lib/utils';
import { passwordStrength } from './passwordStrength';

const COLORS = ['bg-red-500', 'bg-red-500', 'bg-amber-500', 'bg-emerald-500', 'bg-emerald-600'];

/** Four-segment strength bar with a label and a hint (text, not just color). */
export function PasswordStrengthMeter({ password, id }: { password: string; id?: string }) {
  if (!password) return null;
  const strength = passwordStrength(password);
  return (
    <div id={id} className="grid gap-1" aria-live="polite">
      <div className="flex gap-1" aria-hidden="true">
        {[1, 2, 3, 4].map((segment) => (
          <span
            key={segment}
            className={cn(
              'h-1 flex-1 rounded-full',
              segment <= strength.score ? COLORS[strength.score] : 'bg-muted',
            )}
          />
        ))}
      </div>
      <p className="text-xs text-muted-foreground">
        <span className="font-medium text-foreground">{strength.label}.</span> {strength.hint}
      </p>
    </div>
  );
}
