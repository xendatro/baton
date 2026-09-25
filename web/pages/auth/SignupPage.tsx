import { useState, type FormEvent } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { z } from 'zod';
import {
  displayNameSchema,
  emailSchema,
  passwordSchema,
  usernameSchema,
} from '@shared/schemas/common';
import { fieldErrors } from '@web/lib/forms';
import { AuthLayout } from '@web/components/auth/AuthLayout';
import { FormError, FormField } from '@web/components/auth/FormField';
import { markCodeSent } from '@web/components/auth/otp';
import { PasswordInput } from '@web/components/auth/PasswordInput';
import { PasswordStrengthMeter } from '@web/components/auth/PasswordStrengthMeter';
import { SocialButtons } from '@web/components/auth/SocialButtons';
import { UsernameField } from '@web/components/auth/UsernameField';
import { useUsernameAvailability } from '@web/components/auth/useUsernameAvailability';
import { EmptyState } from '@web/components/common/EmptyState';
import { Spinner } from '@web/components/common/Spinner';
import { RedirectIfAuthed } from '@web/components/layout/guards';
import { Button } from '@web/components/ui/button';
import { Input } from '@web/components/ui/input';
import { AuthRequestError, authClient, safeNext, unwrapAuth, useConfig } from '@web/lib/auth';

const signupSchema = z.object({
  name: displayNameSchema,
  username: usernameSchema,
  email: z.string().trim().pipe(emailSchema),
  password: passwordSchema,
});

type Field = keyof z.infer<typeof signupSchema>;

function SignupForm() {
  const navigate = useNavigate();
  const config = useConfig();
  const [params] = useSearchParams();
  const next = safeNext(params.get('next'));
  const [values, setValues] = useState({ name: '', username: '', email: '', password: '' });
  const [errors, setErrors] = useState<Partial<Record<Field, string>>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const usernameCheck = useUsernameAvailability(values.username);
  const nextQuery = next === '/' ? '' : `?next=${encodeURIComponent(next)}`;

  const set = (field: Field) => (value: string) => {
    setValues((current) => ({ ...current, [field]: value }));
    setErrors((current) => ({ ...current, [field]: undefined }));
  };

  async function submit(event: FormEvent) {
    event.preventDefault();
    const parsed = signupSchema.safeParse(values);
    const errorsByField: Partial<Record<Field, string>> = parsed.success
      ? {}
      : fieldErrors<Field>(parsed.error);
    if (usernameCheck.status === 'taken') {
      errorsByField.username = usernameCheck.message ?? 'Taken';
    }
    setErrors(errorsByField);
    if (!parsed.success || Object.keys(errorsByField).length > 0) return;

    setFormError(null);
    setPending(true);
    const { name, username, email, password } = parsed.data;
    try {
      unwrapAuth(await authClient.signUp.email({ name, username, email, password }));
      // The server emails the first code as part of sign-up; start the resend cooldown for it.
      markCodeSent('email-verification', email);
      await navigate(
        `/verify-email?email=${encodeURIComponent(email)}&next=${encodeURIComponent(next)}`,
        { replace: true },
      );
    } catch (error) {
      if (error instanceof AuthRequestError && error.code === 'USERNAME_IS_ALREADY_TAKEN') {
        setErrors({ username: error.message });
      } else if (
        error instanceof AuthRequestError &&
        error.code.startsWith('USER_ALREADY_EXISTS')
      ) {
        setErrors({ email: error.message });
      } else {
        setFormError(error instanceof Error ? error.message : 'Couldn’t create the account.');
      }
    } finally {
      setPending(false);
    }
  }

  if (config.data?.signupsEnabled === false) {
    return (
      <AuthLayout
        title="Sign-ups are closed"
        description="This Baton server isn’t accepting new accounts."
      >
        <EmptyState
          title="Ask an admin for access"
          description="If you already have an account, log in instead."
          action={
            <Button asChild variant="outline">
              <Link to={`/login${nextQuery}`}>Log in</Link>
            </Button>
          }
        />
      </AuthLayout>
    );
  }

  return (
    <AuthLayout
      title="Create your account"
      description="Teams are invite-only: once you’re in, create a team or join with a link."
      footer={
        <>
          Already have an account?{' '}
          <Link to={`/login${nextQuery}`} className="font-medium text-foreground hover:underline">
            Log in
          </Link>
        </>
      }
    >
      <SocialButtons next={next} verb="Sign up with" onError={setFormError} />
      <form className="grid gap-4" onSubmit={(event) => void submit(event)} noValidate>
        <FormField label="Display name" error={errors.name}>
          {(field) => (
            <Input
              {...field}
              value={values.name}
              onChange={(event) => set('name')(event.target.value)}
              autoComplete="name"
              autoFocus
            />
          )}
        </FormField>
        <UsernameField
          value={values.username}
          onChange={set('username')}
          check={usernameCheck}
          error={errors.username}
        />
        <FormField label="Email" error={errors.email}>
          {(field) => (
            <Input
              {...field}
              type="email"
              value={values.email}
              onChange={(event) => set('email')(event.target.value)}
              autoComplete="email"
              autoCapitalize="none"
              spellCheck={false}
            />
          )}
        </FormField>
        <FormField label="Password" error={errors.password}>
          {(field) => (
            <div className="grid gap-2">
              <PasswordInput
                {...field}
                value={values.password}
                onChange={(event) => set('password')(event.target.value)}
                autoComplete="new-password"
              />
              <PasswordStrengthMeter password={values.password} />
            </div>
          )}
        </FormField>
        <FormError message={formError} />
        <Button type="submit" disabled={pending} className="w-full">
          {pending ? <Spinner /> : null}
          Create account
        </Button>
      </form>
    </AuthLayout>
  );
}

export default function SignupPage() {
  return (
    <RedirectIfAuthed>
      <SignupForm />
    </RedirectIfAuthed>
  );
}
