import { BadgeCheckIcon, MailIcon } from 'lucide-react';
import { ErrorState } from '@web/components/common/ErrorState';
import { Badge } from '@web/components/ui/badge';
import { useMe } from '@web/lib/auth';
import { DeleteAccountCard } from './DeleteAccountCard';
import { DeletedTeamsCard } from './DeletedTeamsCard';
import { PasswordCard } from './PasswordCard';
import { useConnections } from './queries';
import { SettingsCard, SettingsCardSkeleton, SettingsPage } from './SettingsCard';

function EmailCard({ email, verified }: { email: string; verified: boolean }) {
  return (
    <SettingsCard
      title="Email"
      description="Used to sign in, for one-time codes and for password resets. It can’t be changed."
    >
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <MailIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        <span className="min-w-0 truncate text-sm font-medium">{email}</span>
        {verified ? (
          <Badge variant="secondary" className="gap-1">
            <BadgeCheckIcon aria-hidden="true" className="text-emerald-600 dark:text-emerald-400" />
            Verified
          </Badge>
        ) : null}
      </div>
    </SettingsCard>
  );
}

export default function AccountSettingsPage() {
  const me = useMe();
  const connections = useConnections();
  return (
    <SettingsPage title="Account" description="Your email, password and account lifecycle.">
      {me.isError ? (
        <ErrorState error={me.error} onRetry={() => void me.refetch()} />
      ) : connections.isError ? (
        <ErrorState error={connections.error} onRetry={() => void connections.refetch()} />
      ) : me.isPending || connections.isPending ? (
        <>
          <SettingsCardSkeleton rows={1} />
          <SettingsCardSkeleton rows={3} />
          <SettingsCardSkeleton rows={1} />
        </>
      ) : (
        <>
          <EmailCard email={me.data.user.email} verified={me.data.user.emailVerified} />
          <PasswordCard hasPassword={connections.data.hasPassword} email={me.data.user.email} />
          <DeletedTeamsCard />
          <DeleteAccountCard me={me.data} hasPassword={connections.data.hasPassword} />
        </>
      )}
    </SettingsPage>
  );
}
