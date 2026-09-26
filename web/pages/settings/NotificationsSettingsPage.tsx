import { BellRingIcon, Volume2Icon } from 'lucide-react';
import { useId, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@web/components/ui/button';
import { Label } from '@web/components/ui/label';
import { Switch } from '@web/components/ui/switch';
import {
  desktopPermission,
  playChime,
  requestDesktopPermission,
  setAlertPrefs,
  useAlertPrefs,
  type DesktopPermission,
} from '@web/lib/desktopNotifications';
import { SettingsCard, SettingsPage } from './SettingsCard';

const PERMISSION_HINTS: Record<DesktopPermission, string | null> = {
  granted: null,
  default: 'Your browser will ask for permission when you turn this on.',
  denied:
    'Your browser blocks notifications from Baton. Allow them in the site settings (the icon left of the address), then turn this on again.',
  unsupported: 'This browser doesn’t support desktop notifications.',
};

/** `/settings/notifications`: desktop notifications and the notification sound (BAT-2). */
export default function NotificationsSettingsPage() {
  const prefs = useAlertPrefs();
  const [permission, setPermission] = useState<DesktopPermission>(desktopPermission);
  const desktopId = useId();
  const soundId = useId();
  const desktopOn = prefs.desktop && permission === 'granted';

  const toggleDesktop = async (on: boolean) => {
    if (!on) {
      setAlertPrefs({ desktop: false });
      return;
    }
    const result = await requestDesktopPermission();
    setPermission(result);
    if (result === 'granted') {
      setAlertPrefs({ desktop: true });
      toast.success('Desktop notifications on');
    } else {
      setAlertPrefs({ desktop: false });
      toast.error('Notifications are blocked by your browser');
    }
  };

  return (
    <SettingsPage
      title="Notifications"
      description="How this device tells you about new items in your inbox. Other devices keep their own settings."
    >
      <SettingsCard
        title="Desktop notifications"
        description="Show a system notification for each new inbox item while Baton is in the background. Clicking it opens the item."
      >
        <div className="flex items-start justify-between gap-4">
          <div className="flex items-start gap-3">
            <BellRingIcon className="mt-0.5 size-4 text-muted-foreground" aria-hidden="true" />
            <div className="space-y-1">
              <Label htmlFor={desktopId}>Show desktop notifications</Label>
              {PERMISSION_HINTS[permission] ? (
                <p className="text-xs text-muted-foreground">{PERMISSION_HINTS[permission]}</p>
              ) : null}
            </div>
          </div>
          <Switch
            id={desktopId}
            checked={desktopOn}
            disabled={permission === 'unsupported'}
            onCheckedChange={(on) => void toggleDesktop(on)}
          />
        </div>
      </SettingsCard>

      <SettingsCard
        title="Sound"
        description="Play a short chime when something new arrives in your inbox, even while you're on another page."
      >
        <div className="flex items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <Volume2Icon className="size-4 text-muted-foreground" aria-hidden="true" />
            <Label htmlFor={soundId}>Play a sound</Label>
          </div>
          <div className="flex items-center gap-3">
            <Button variant="outline" size="sm" onClick={playChime}>
              Test sound
            </Button>
            <Switch
              id={soundId}
              checked={prefs.sound}
              onCheckedChange={(on) => setAlertPrefs({ sound: on })}
            />
          </div>
        </div>
      </SettingsCard>
    </SettingsPage>
  );
}
