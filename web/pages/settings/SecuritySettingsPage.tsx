import {
  AppWindowIcon,
  KeyRoundIcon,
  LinkIcon,
  LockKeyholeIcon,
  LogInIcon,
  LogOutIcon,
  MonitorIcon,
  ShieldCheckIcon,
  SmartphoneIcon,
  TabletIcon,
  UserPenIcon,
  UserPlusIcon,
  type LucideIcon,
} from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import type { AccountSession } from '@shared/schemas/account';
import { ConfirmDialog } from '@web/components/common/ConfirmDialog';
import { EmptyState } from '@web/components/common/EmptyState';
import { ErrorState } from '@web/components/common/ErrorState';
import { RelativeTime } from '@web/components/common/RelativeTime';
import { Spinner } from '@web/components/common/Spinner';
import { Badge } from '@web/components/ui/badge';
import { Button } from '@web/components/ui/button';
import { Skeleton } from '@web/components/ui/skeleton';
import { pluralize } from '@web/lib/format';
import { useRevokeOtherSessions, useRevokeSession, useSecurityLog, useSessions } from './queries';
import { describeSecurityEvent, type SecurityEventKind } from './securityLog';
import { SettingsCard, SettingsPage } from './SettingsCard';

// ---------------------------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------------------------

const DEVICE_ICONS: Record<AccountSession['device'], LucideIcon> = {
  desktop: MonitorIcon,
  mobile: SmartphoneIcon,
  tablet: TabletIcon,
};

function sessionName(session: AccountSession): string {
  if (session.browser && session.os) return `${session.browser} on ${session.os}`;
  return session.browser ?? session.os ?? 'Unknown device';
}

function SessionRow({ session }: { session: AccountSession }) {
  const revoke = useRevokeSession();
  const Icon = DEVICE_ICONS[session.device];
  const name = sessionName(session);
  return (
    <li className="flex flex-wrap items-center gap-x-4 gap-y-2 py-3 first:pt-0 last:pb-0">
      <span className="flex size-9 shrink-0 items-center justify-center rounded-md border bg-background text-muted-foreground">
        <Icon className="size-4" aria-hidden="true" />
      </span>
      <div className="min-w-0 flex-1 basis-56">
        <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
          {name}
          {session.current ? (
            <Badge className="bg-emerald-500/10 font-normal text-emerald-700 dark:text-emerald-300">
              This device
            </Badge>
          ) : null}
        </p>
        <p className="mt-0.5 flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
          {session.ipAddress ? <span>{session.ipAddress}</span> : null}
          <span>
            Signed in <RelativeTime value={session.createdAt} />
          </span>
          <span>
            {session.current ? (
              'Active now'
            ) : (
              <>
                Last active <RelativeTime value={session.lastActiveAt} />
              </>
            )}
          </span>
        </p>
      </div>
      {session.current ? null : (
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={revoke.isPending}
          aria-label={`Sign out ${name}`}
          onClick={() =>
            revoke.mutate(session.id, { onSuccess: () => toast.success(`Signed out ${name}`) })
          }
        >
          {revoke.isPending ? <Spinner /> : <LogOutIcon aria-hidden="true" />}
          Sign out
        </Button>
      )}
    </li>
  );
}

function SessionsCard() {
  const sessions = useSessions();
  const revokeOthers = useRevokeOtherSessions();
  const [confirming, setConfirming] = useState(false);
  const others = sessions.data?.items.filter((session) => !session.current).length ?? 0;

  return (
    <SettingsCard
      title="Active sessions"
      description="Browsers signed in to your account. Sign out any you don’t recognise, then change your password."
      action={
        others > 0 ? (
          <Button type="button" variant="outline" size="sm" onClick={() => setConfirming(true)}>
            <LogOutIcon aria-hidden="true" />
            Sign out other sessions
          </Button>
        ) : null
      }
    >
      {sessions.isPending ? (
        <div className="grid gap-4" aria-hidden="true">
          {[0, 1].map((row) => (
            <div key={row} className="flex items-center gap-4">
              <Skeleton className="size-9 rounded-md" />
              <div className="grid flex-1 gap-2">
                <Skeleton className="h-4 w-40" />
                <Skeleton className="h-3 w-64 max-w-full" />
              </div>
            </div>
          ))}
        </div>
      ) : sessions.isError ? (
        <ErrorState error={sessions.error} onRetry={() => void sessions.refetch()} />
      ) : (
        <ul className="divide-y" aria-label="Active sessions">
          {sessions.data.items.map((session) => (
            <SessionRow key={session.id} session={session} />
          ))}
        </ul>
      )}
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title="Sign out other sessions?"
        description={`${pluralize(others, 'other session')} will be signed out. This browser stays signed in.`}
        confirmLabel="Sign out others"
        destructive
        onConfirm={async () => {
          const result = await revokeOthers.mutateAsync();
          toast.success(`Signed out ${pluralize(result.revoked, 'other session')}`);
        }}
      />
    </SettingsCard>
  );
}

// ---------------------------------------------------------------------------------------------
// Security log
// ---------------------------------------------------------------------------------------------

const KIND_ICONS: Record<SecurityEventKind, LucideIcon> = {
  'sign-in': LogInIcon,
  account: UserPlusIcon,
  password: LockKeyholeIcon,
  connection: LinkIcon,
  'api-key': KeyRoundIcon,
  session: AppWindowIcon,
  profile: UserPenIcon,
};

function SecurityLogCard() {
  const log = useSecurityLog();
  const entries = log.data?.pages.flatMap((page) => page.items) ?? [];

  return (
    <SettingsCard
      title="Security log"
      description="Sign-ins and changes to your account, newest first. Only you can see this."
    >
      {log.isPending ? (
        <div className="grid gap-4" aria-hidden="true">
          {[0, 1, 2, 3].map((row) => (
            <div key={row} className="flex items-center gap-3">
              <Skeleton className="size-7 rounded-full" />
              <div className="grid flex-1 gap-2">
                <Skeleton className="h-3.5 w-56 max-w-full" />
                <Skeleton className="h-3 w-40" />
              </div>
            </div>
          ))}
        </div>
      ) : log.isError ? (
        <ErrorState error={log.error} onRetry={() => void log.refetch()} />
      ) : entries.length === 0 ? (
        <EmptyState
          icon={ShieldCheckIcon}
          title="Nothing here yet"
          description="Sign-ins, password changes and API keys will be listed here."
        />
      ) : (
        <>
          <ol className="grid gap-0.5" aria-label="Security log">
            {entries.map((entry) => {
              const event = describeSecurityEvent(entry);
              const Icon = KIND_ICONS[event.kind];
              return (
                <li key={entry.id} className="flex gap-3 rounded-md px-1 py-2">
                  <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground">
                    <Icon className="size-3.5" aria-hidden="true" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm break-words">{event.title}</p>
                    <p className="flex flex-wrap gap-x-2 text-xs text-muted-foreground">
                      <RelativeTime value={entry.createdAt} />
                      {event.details.map((detail) => (
                        <span key={detail} className="break-all">
                          · {detail}
                        </span>
                      ))}
                    </p>
                  </div>
                </li>
              );
            })}
          </ol>
          {log.hasNextPage ? (
            <div className="mt-3 flex justify-center">
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={log.isFetchingNextPage}
                onClick={() => void log.fetchNextPage()}
              >
                {log.isFetchingNextPage ? <Spinner /> : null}
                Show older events
              </Button>
            </div>
          ) : null}
        </>
      )}
    </SettingsCard>
  );
}

export default function SecuritySettingsPage() {
  return (
    <SettingsPage
      title="Security"
      description="Where you’re signed in, and what happened to your account."
    >
      <SessionsCard />
      <SecurityLogCard />
    </SettingsPage>
  );
}
