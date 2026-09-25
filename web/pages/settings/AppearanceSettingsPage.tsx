import { CheckIcon, MonitorIcon, MoonIcon, SunIcon, type LucideIcon } from 'lucide-react';
import { RadioGroup } from 'radix-ui';
import { THEMES, type Theme } from '@shared/constants';
import { Kbd } from '@web/components/common/Kbd';
import { useTheme } from '@web/lib/theme';
import { cn } from '@web/lib/utils';
import { SettingsCard, SettingsPage } from './SettingsCard';

const OPTIONS: Record<Theme, { label: string; description: string; icon: LucideIcon }> = {
  light: { label: 'Light', description: 'Always light', icon: SunIcon },
  dark: { label: 'Dark', description: 'Always dark', icon: MoonIcon },
  system: { label: 'System', description: 'Follows your device', icon: MonitorIcon },
};

function isTheme(value: string): value is Theme {
  return (THEMES as readonly string[]).includes(value);
}

/** A miniature app window in fixed light or dark colors (independent of the current theme). */
function MiniApp({ mode, className }: { mode: 'light' | 'dark'; className?: string }) {
  const dark = mode === 'dark';
  return (
    <div
      className={cn(
        'flex h-full w-full overflow-hidden',
        dark ? 'bg-zinc-950' : 'bg-white',
        className,
      )}
    >
      <div
        className={cn(
          'flex w-1/4 flex-col gap-1.5 border-r p-2',
          dark ? 'border-white/10 bg-zinc-900' : 'border-zinc-200 bg-zinc-50',
        )}
      >
        <span className="h-1.5 w-3/4 rounded-full bg-indigo-500" />
        <span className={cn('h-1.5 w-full rounded-full', dark ? 'bg-zinc-700' : 'bg-zinc-200')} />
        <span className={cn('h-1.5 w-2/3 rounded-full', dark ? 'bg-zinc-700' : 'bg-zinc-200')} />
        <span className={cn('h-1.5 w-5/6 rounded-full', dark ? 'bg-zinc-700' : 'bg-zinc-200')} />
      </div>
      <div className="flex flex-1 flex-col gap-2 p-2.5">
        <span className={cn('h-2 w-1/2 rounded-full', dark ? 'bg-zinc-500' : 'bg-zinc-400')} />
        {[0, 1, 2].map((row) => (
          <div
            key={row}
            className={cn(
              'flex items-center gap-1.5 rounded border px-1.5 py-1',
              dark ? 'border-white/10 bg-zinc-900' : 'border-zinc-200 bg-white',
            )}
          >
            <span
              className={cn(
                'size-1.5 shrink-0 rounded-full',
                row === 0 ? 'bg-emerald-500' : row === 1 ? 'bg-amber-500' : 'bg-indigo-500',
              )}
            />
            <span
              className={cn('h-1.5 flex-1 rounded-full', dark ? 'bg-zinc-700' : 'bg-zinc-200')}
            />
          </div>
        ))}
      </div>
    </div>
  );
}

function Preview({ theme }: { theme: Theme }) {
  if (theme === 'system') {
    return (
      <div className="relative h-full w-full">
        <MiniApp mode="light" className="absolute inset-0" />
        <MiniApp
          mode="dark"
          className="absolute inset-0 [clip-path:polygon(100%_0,100%_100%,0_100%)]"
        />
      </div>
    );
  }
  return <MiniApp mode={theme} />;
}

export default function AppearanceSettingsPage() {
  const { theme, resolvedTheme, setTheme } = useTheme();
  return (
    <SettingsPage title="Appearance" description="How Baton looks on this and your other devices.">
      <SettingsCard
        title="Theme"
        description={
          <>
            Saved to your profile, so it follows you when you sign in elsewhere.
            {theme === 'system' ? ` Your device is currently in ${resolvedTheme} mode.` : null}
          </>
        }
      >
        <RadioGroup.Root
          value={theme}
          onValueChange={(value) => {
            if (isTheme(value)) setTheme(value);
          }}
          aria-label="Theme"
          className="grid gap-3 sm:grid-cols-3"
        >
          {(['light', 'dark', 'system'] as const).map((option) => {
            const { label, description, icon: Icon } = OPTIONS[option];
            const selected = theme === option;
            return (
              <RadioGroup.Item
                key={option}
                value={option}
                className={cn(
                  'group grid overflow-hidden rounded-lg border text-left transition-colors outline-none hover:border-foreground/30 focus-visible:ring-[3px] focus-visible:ring-ring/50',
                  selected && 'border-primary ring-1 ring-primary hover:border-primary',
                )}
              >
                <span className="block aspect-[16/9] border-b" aria-hidden="true">
                  <Preview theme={option} />
                </span>
                <span className="flex items-center gap-2 px-3 py-2.5">
                  <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                  <span className="grid min-w-0 flex-1">
                    <span className="text-sm font-medium">{label}</span>
                    <span className="text-xs text-muted-foreground">{description}</span>
                  </span>
                  <span
                    className={cn(
                      'flex size-5 shrink-0 items-center justify-center rounded-full border',
                      selected && 'border-primary bg-primary text-primary-foreground',
                    )}
                    aria-hidden="true"
                  >
                    {selected ? <CheckIcon className="size-3" /> : null}
                  </span>
                </span>
              </RadioGroup.Item>
            );
          })}
        </RadioGroup.Root>
        <p className="mt-4 text-xs text-muted-foreground">
          You can also switch themes from the command palette (<Kbd keys="mod+k" />) or the account
          menu.
        </p>
      </SettingsCard>
    </SettingsPage>
  );
}
