import { useState, type ReactElement } from 'react';
import { Spinner } from '@web/components/common/Spinner';
import { Button } from '@web/components/ui/button';
import { authClient, unwrapAuth, useConfig } from '@web/lib/auth';

type Provider = 'google' | 'github';

function GoogleIcon() {
  return (
    <svg viewBox="0 0 24 24" className="size-4" aria-hidden="true">
      <path
        fill="#4285F4"
        d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.27-4.74 3.27-8.1Z"
      />
      <path
        fill="#34A853"
        d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84A11 11 0 0 0 12 23Z"
      />
      <path
        fill="#FBBC05"
        d="M5.84 14.1A6.6 6.6 0 0 1 5.5 12c0-.73.13-1.44.34-2.1V7.06H2.18a11 11 0 0 0 0 9.88l3.66-2.84Z"
      />
      <path
        fill="#EA4335"
        d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15A10.96 10.96 0 0 0 12 1 11 11 0 0 0 2.18 7.06l3.66 2.84C6.71 7.31 9.14 5.38 12 5.38Z"
      />
    </svg>
  );
}

function GitHubIcon() {
  return (
    <svg viewBox="0 0 24 24" className="size-4 fill-current" aria-hidden="true">
      <path d="M12 .5a11.5 11.5 0 0 0-3.64 22.41c.58.1.79-.25.79-.56v-2c-3.2.7-3.87-1.36-3.87-1.36-.52-1.33-1.28-1.69-1.28-1.69-1.05-.71.08-.7.08-.7 1.16.08 1.77 1.19 1.77 1.19 1.03 1.77 2.7 1.26 3.36.96.1-.75.4-1.26.73-1.55-2.55-.29-5.24-1.28-5.24-5.69 0-1.26.45-2.28 1.19-3.09-.12-.29-.52-1.46.11-3.05 0 0 .97-.31 3.17 1.18a11 11 0 0 1 5.77 0c2.2-1.49 3.17-1.18 3.17-1.18.63 1.59.23 2.76.11 3.05.74.81 1.19 1.83 1.19 3.09 0 4.42-2.7 5.39-5.26 5.68.41.36.78 1.06.78 2.14v3.17c0 .31.21.67.8.56A11.5 11.5 0 0 0 12 .5Z" />
    </svg>
  );
}

const PROVIDERS: Record<Provider, { label: string; icon: () => ReactElement }> = {
  google: { label: 'Google', icon: GoogleIcon },
  github: { label: 'GitHub', icon: GitHubIcon },
};

export interface SocialButtonsProps {
  /** Where to land after signing in (already sanitised). */
  next: string;
  /** "Continue with" (sign-in) or "Sign up with". */
  verb?: string;
  onError: (message: string) => void;
}

/**
 * Google / GitHub buttons, only for providers the server enables (`GET /api/config`). New OAuth
 * users land on the username step first.
 */
export function SocialButtons({ next, verb = 'Continue with', onError }: SocialButtonsProps) {
  const config = useConfig();
  const [pending, setPending] = useState<Provider | null>(null);
  const enabled = (['google', 'github'] as const).filter((p) => config.data?.providers[p]);
  if (enabled.length === 0) return null;

  const signIn = async (provider: Provider) => {
    setPending(provider);
    try {
      const origin = window.location.origin;
      unwrapAuth(
        await authClient.signIn.social({
          provider,
          callbackURL: `${origin}${next}`,
          newUserCallbackURL: `${origin}/onboarding/username?next=${encodeURIComponent(next)}`,
          errorCallbackURL: `${origin}/login`,
        }),
      );
      // The browser is being redirected to the provider.
    } catch (error) {
      setPending(null);
      onError(error instanceof Error ? error.message : 'Couldn’t start sign-in.');
    }
  };

  return (
    <div className="grid gap-4">
      <div className={enabled.length > 1 ? 'grid grid-cols-2 gap-2' : 'grid'}>
        {enabled.map((provider) => {
          const { label, icon: Icon } = PROVIDERS[provider];
          return (
            <Button
              key={provider}
              type="button"
              variant="outline"
              disabled={pending !== null}
              onClick={() => void signIn(provider)}
              aria-label={`${verb} ${label}`}
            >
              {pending === provider ? <Spinner /> : <Icon />}
              {label}
            </Button>
          );
        })}
      </div>
      <div className="flex items-center gap-3 text-xs text-muted-foreground">
        <span className="h-px flex-1 bg-border" />
        or
        <span className="h-px flex-1 bg-border" />
      </div>
    </div>
  );
}
