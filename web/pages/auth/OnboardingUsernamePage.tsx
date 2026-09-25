import { useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { Navigate, useNavigate, useSearchParams } from 'react-router';
import { usernameSchema } from '@shared/schemas/common';
import { AuthLayout } from '@web/components/auth/AuthLayout';
import { FormError } from '@web/components/auth/FormField';
import { UsernameField } from '@web/components/auth/UsernameField';
import { useUsernameAvailability } from '@web/components/auth/useUsernameAvailability';
import { ErrorState } from '@web/components/common/ErrorState';
import { LoadingScreen, Spinner } from '@web/components/common/Spinner';
import { RequireAuth } from '@web/components/layout/guards';
import { Button } from '@web/components/ui/button';
import {
  AuthRequestError,
  authClient,
  refreshAuth,
  safeNext,
  unwrapAuth,
  useMe,
} from '@web/lib/auth';

function suggestUsername(name: string, email: string): string {
  const base = (name || email.split('@')[0] || '')
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 32);
  return base.length >= 3 ? base : '';
}

function UsernameForm({ initial, next }: { initial: string; next: string }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [username, setUsername] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const check = useUsernameAvailability(username);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const parsed = usernameSchema.safeParse(username);
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? 'Invalid username');
      return;
    }
    if (check.status === 'taken') {
      setError(check.message);
      return;
    }
    setError(null);
    setFormError(null);
    setPending(true);
    try {
      unwrapAuth(await authClient.updateUser({ username: parsed.data }));
      await refreshAuth(queryClient);
      await navigate(next, { replace: true });
    } catch (cause) {
      if (cause instanceof AuthRequestError && cause.code === 'USERNAME_IS_ALREADY_TAKEN') {
        setError(cause.message);
      } else {
        setFormError(cause instanceof Error ? cause.message : 'Couldn’t save the username.');
      }
    } finally {
      setPending(false);
    }
  }

  return (
    <form className="grid gap-4" onSubmit={(event) => void submit(event)} noValidate>
      <UsernameField
        value={username}
        onChange={(value) => {
          setUsername(value);
          setError(null);
        }}
        check={check}
        error={error}
        autoFocus
      />
      <FormError message={formError} />
      <Button type="submit" disabled={pending} className="w-full">
        {pending ? <Spinner /> : null}
        Continue
      </Button>
    </form>
  );
}

function Onboarding() {
  const [params] = useSearchParams();
  const next = safeNext(params.get('next'));
  const me = useMe();
  if (me.isPending) return <LoadingScreen />;
  if (me.isError) {
    return (
      <div className="flex min-h-svh items-center justify-center p-4">
        <ErrorState error={me.error} onRetry={() => void me.refetch()} className="max-w-md" />
      </div>
    );
  }
  if (me.data.user.username) return <Navigate to={next} replace />;
  return (
    <AuthLayout
      title="Choose a username"
      description="Teammates will @mention you with it. You can change it later in settings."
    >
      <UsernameForm initial={suggestUsername(me.data.user.name, me.data.user.email)} next={next} />
    </AuthLayout>
  );
}

export default function OnboardingUsernamePage() {
  return (
    <RequireAuth>
      <Onboarding />
    </RequireAuth>
  );
}
