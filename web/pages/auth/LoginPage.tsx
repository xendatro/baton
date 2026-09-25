import { useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { toast } from 'sonner';
import { z } from 'zod';
import { fieldErrors } from '@web/lib/forms';
import { AuthLayout } from '@web/components/auth/AuthLayout';
import { FormError, FormField } from '@web/components/auth/FormField';
import { sendVerificationCode } from '@web/components/auth/otp';
import { PasswordInput } from '@web/components/auth/PasswordInput';
import { SocialButtons } from '@web/components/auth/SocialButtons';
import { Spinner } from '@web/components/common/Spinner';
import { RedirectIfAuthed } from '@web/components/layout/guards';
import { Button } from '@web/components/ui/button';
import { Input } from '@web/components/ui/input';
import {
  AuthRequestError,
  authClient,
  refreshAuth,
  safeNext,
  unwrapAuth,
  useConfig,
} from '@web/lib/auth';

const loginSchema = z.object({
  identifier: z.string().trim().min(1, 'Enter your email or username'),
  password: z.string().min(1, 'Enter your password'),
});

type Field = keyof z.infer<typeof loginSchema>;

function LoginForm() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const config = useConfig();
  const [params] = useSearchParams();
  const next = safeNext(params.get('next'));
  const [identifier, setIdentifier] = useState(params.get('email') ?? '');
  const [password, setPassword] = useState('');
  const [errors, setErrors] = useState<Partial<Record<Field, string>>>({});
  const [formError, setFormError] = useState<string | null>(
    params.get('error') ? 'Sign-in with that provider didn’t complete. Try again.' : null,
  );
  const [pending, setPending] = useState(false);
  const nextQuery = next === '/' ? '' : `?next=${encodeURIComponent(next)}`;

  async function submit(event: FormEvent) {
    event.preventDefault();
    const parsed = loginSchema.safeParse({ identifier, password });
    if (!parsed.success) {
      setErrors(fieldErrors<Field>(parsed.error));
      return;
    }
    setErrors({});
    setFormError(null);
    setPending(true);
    const { identifier: id, password: secret } = parsed.data;
    const isEmail = id.includes('@');
    try {
      unwrapAuth(
        isEmail
          ? await authClient.signIn.email({ email: id.toLowerCase(), password: secret })
          : await authClient.signIn.username({ username: id.toLowerCase(), password: secret }),
      );
      await refreshAuth(queryClient);
      await navigate(next, { replace: true });
    } catch (error) {
      if (error instanceof AuthRequestError && error.code === 'EMAIL_NOT_VERIFIED') {
        toast.info('Verify your email to finish signing in.');
        if (!isEmail) {
          // Signed in by username: the verify page asks for the address and sends the code.
          await navigate(`/verify-email?next=${encodeURIComponent(next)}`);
          return;
        }
        try {
          await sendVerificationCode(id);
        } catch {
          // The verify page offers a resend.
        }
        await navigate(
          `/verify-email?email=${encodeURIComponent(id.toLowerCase())}&next=${encodeURIComponent(next)}`,
        );
        return;
      }
      setFormError(error instanceof Error ? error.message : 'Couldn’t sign in.');
    } finally {
      setPending(false);
    }
  }

  return (
    <AuthLayout
      title="Log in to Baton"
      description="Welcome back. Pick up where your team left off."
      footer={
        config.data?.signupsEnabled === false ? null : (
          <>
            Don’t have an account?{' '}
            <Link
              to={`/signup${nextQuery}`}
              className="font-medium text-foreground hover:underline"
            >
              Sign up
            </Link>
          </>
        )
      }
    >
      <SocialButtons next={next} onError={setFormError} />
      <form className="grid gap-4" onSubmit={(event) => void submit(event)} noValidate>
        <FormField label="Email or username" error={errors.identifier}>
          {(field) => (
            <Input
              {...field}
              value={identifier}
              onChange={(event) => setIdentifier(event.target.value)}
              autoComplete="username"
              autoCapitalize="none"
              spellCheck={false}
              autoFocus
            />
          )}
        </FormField>
        <FormField
          label="Password"
          error={errors.password}
          aside={
            <Link
              to={`/forgot-password${identifier.includes('@') ? `?email=${encodeURIComponent(identifier.trim())}` : ''}`}
              className="text-xs text-muted-foreground hover:text-foreground hover:underline"
            >
              Forgot password?
            </Link>
          }
        >
          {(field) => (
            <PasswordInput
              {...field}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              autoComplete="current-password"
            />
          )}
        </FormField>
        <FormError message={formError} />
        <Button type="submit" disabled={pending} className="w-full">
          {pending ? <Spinner /> : null}
          Log in
        </Button>
      </form>
    </AuthLayout>
  );
}

export default function LoginPage() {
  return (
    <RedirectIfAuthed>
      <LoginForm />
    </RedirectIfAuthed>
  );
}
