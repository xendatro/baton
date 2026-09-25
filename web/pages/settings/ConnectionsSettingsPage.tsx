import { KeyRoundIcon, LinkIcon, UnlinkIcon } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { toast } from 'sonner';
import {
  SOCIAL_PROVIDERS,
  type ConnectionsResponse,
  type LinkedAccount,
  type SocialProvider,
} from '@shared/schemas/account';
import { ConfirmDialog } from '@web/components/common/ConfirmDialog';
import { ErrorState } from '@web/components/common/ErrorState';
import { RelativeTime } from '@web/components/common/RelativeTime';
import { Spinner } from '@web/components/common/Spinner';
import { Badge } from '@web/components/ui/badge';
import { Button } from '@web/components/ui/button';
import { authClient, unwrapAuth, useConfig } from '@web/lib/auth';
import { errorMessage } from '@web/lib/api';
import { ProviderIcon } from './ProviderIcon';
import { useConnections, useDisconnectAccount } from './queries';
import { SettingsCard, SettingsCardSkeleton, SettingsPage } from './SettingsCard';

const PROVIDER_LABELS: Record<SocialProvider, string> = { google: 'Google', github: 'GitHub' };

/** Messages for the `?error=` Better Auth adds when linking fails at the provider's callback. */
const LINK_ERRORS: Record<string, string> = {
  account_already_linked_to_different_user:
    'That account is already connected to another Baton user.',
  unable_to_link_account: 'Baton couldn’t connect that account. Try again.',
  email_not_verified: 'The provider hasn’t verified that account’s email address.',
  access_denied: 'Connecting was cancelled.',
};

function linkErrorMessage(code: string): string {
  return LINK_ERRORS[code] ?? 'Baton couldn’t connect that account. Try again.';
}

interface ProviderRowProps {
  provider: SocialProvider;
  account: LinkedAccount | undefined;
  configured: boolean;
  /** Removing this account would leave no way to sign in. */
  isLastMethod: boolean;
}

function ProviderRow({ provider, account, configured, isLastMethod }: ProviderRowProps) {
  const disconnectAccount = useDisconnectAccount();
  const label = PROVIDER_LABELS[provider];
  const [connecting, setConnecting] = useState(false);
  const [confirming, setConfirming] = useState(false);

  async function connect() {
    setConnecting(true);
    try {
      const target = `${window.location.origin}/settings/connections`;
      unwrapAuth(
        await authClient.linkSocial({
          provider,
          callbackURL: `${target}?linked=${provider}`,
          errorCallbackURL: target,
        }),
      );
      // The browser is on its way to the provider.
    } catch (cause) {
      setConnecting(false);
      toast.error(errorMessage(cause, `Couldn’t connect ${label}.`));
    }
  }

  async function disconnect() {
    await disconnectAccount.mutateAsync(provider);
    toast.success(`${label} disconnected`);
  }

  return (
    <li className="flex flex-wrap items-center gap-3 py-4 first:pt-0 last:pb-0">
      <span className="flex size-10 shrink-0 items-center justify-center rounded-md border bg-background">
        <ProviderIcon provider={provider} />
      </span>
      <div className="min-w-0 flex-1">
        <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
          {label}
          {account ? (
            <Badge variant="secondary" className="font-normal">
              Connected
            </Badge>
          ) : null}
        </p>
        <p className="text-xs break-words text-muted-foreground">
          {account ? (
            <>
              {account.label ? (
                <>
                  Connected as <span className="font-medium text-foreground">{account.label}</span>{' '}
                  ·{' '}
                </>
              ) : null}
              linked <RelativeTime value={account.connectedAt} />
            </>
          ) : configured ? (
            `Sign in with your ${label} account.`
          ) : (
            `${label} sign-in is not configured on this server.`
          )}
        </p>
        {account && isLastMethod ? (
          <p className="mt-1 text-xs text-muted-foreground">
            This is your only way to sign in.{' '}
            <Link to="/settings/account" className="text-primary hover:underline">
              Set a password
            </Link>{' '}
            or connect another account before disconnecting it.
          </p>
        ) : null}
      </div>
      {account ? (
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={isLastMethod}
          onClick={() => setConfirming(true)}
          aria-label={`Disconnect ${label}`}
        >
          <UnlinkIcon aria-hidden="true" />
          Disconnect
        </Button>
      ) : (
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={!configured || connecting}
          onClick={() => void connect()}
          aria-label={`Connect ${label}`}
        >
          {connecting ? <Spinner /> : <LinkIcon aria-hidden="true" />}
          Connect
        </Button>
      )}
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title={`Disconnect ${label}?`}
        description={`You won’t be able to sign in with ${label} until you connect it again.`}
        confirmLabel="Disconnect"
        destructive
        onConfirm={disconnect}
      />
    </li>
  );
}

function SignInMethods({ data }: { data: ConnectionsResponse }) {
  const config = useConfig().data;
  const methods = data.accounts.length + (data.hasPassword ? 1 : 0);
  return (
    <>
      <SettingsCard
        title="Connected accounts"
        description="Sign in to Baton with Google or GitHub as well as your email. The connected account can use a different email address."
      >
        <ul className="divide-y">
          {SOCIAL_PROVIDERS.map((provider) => (
            <ProviderRow
              key={provider}
              provider={provider}
              account={data.accounts.find((account) => account.provider === provider)}
              configured={config?.providers[provider] ?? false}
              isLastMethod={methods <= 1}
            />
          ))}
        </ul>
      </SettingsCard>
      <SettingsCard
        title="Email and password"
        description={
          data.hasPassword
            ? 'You can sign in with your email address and password.'
            : 'No password yet: you sign in only with a connected account.'
        }
        action={
          <Button asChild variant="outline" size="sm">
            <Link to="/settings/account">
              <KeyRoundIcon aria-hidden="true" />
              {data.hasPassword ? 'Change password' : 'Set a password'}
            </Link>
          </Button>
        }
      />
    </>
  );
}

export default function ConnectionsSettingsPage() {
  const connections = useConnections();
  const [params, setParams] = useSearchParams();
  const error = params.get('error');
  const linked = params.get('linked');

  // Results of the round trip through the provider, reported once.
  useEffect(() => {
    if (!error && !linked) return;
    if (error) toast.error(linkErrorMessage(error));
    else if (linked === 'google' || linked === 'github') {
      toast.success(`${PROVIDER_LABELS[linked]} connected`);
    }
    setParams({}, { replace: true });
  }, [error, linked, setParams]);

  return (
    <SettingsPage
      title="Connections"
      description="The ways you can sign in to Baton. You can’t remove the last one."
    >
      {connections.isPending ? (
        <>
          <SettingsCardSkeleton rows={2} />
          <SettingsCardSkeleton rows={0} />
        </>
      ) : connections.isError ? (
        <ErrorState error={connections.error} onRetry={() => void connections.refetch()} />
      ) : (
        <SignInMethods data={connections.data} />
      )}
    </SettingsPage>
  );
}
