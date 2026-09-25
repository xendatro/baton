import { useQueryClient } from '@tanstack/react-query';
import { MailCheckIcon } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { toast } from 'sonner';
import { OTP } from '@shared/constants';
import { emailSchema } from '@shared/schemas/common';
import { AuthLayout } from '@web/components/auth/AuthLayout';
import { FormError, FormField } from '@web/components/auth/FormField';
import { OtpInput } from '@web/components/auth/OtpInput';
import { sendVerificationCode, useResendCooldown } from '@web/components/auth/otp';
import { Spinner } from '@web/components/common/Spinner';
import { Button } from '@web/components/ui/button';
import { Input } from '@web/components/ui/input';
import {
  authClient,
  fetchSession,
  refreshAuth,
  safeNext,
  unwrapAuth,
  useMe,
  useSession,
} from '@web/lib/auth';
import { queryKeys } from '@web/lib/queryKeys';

function VerifyCode({ email, next }: { email: string; next: string }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const cooldown = useResendCooldown('email-verification', email);
  const [attempt, setAttempt] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [resending, setResending] = useState(false);

  async function verify(code: string) {
    if (pending) return;
    setPending(true);
    setError(null);
    try {
      unwrapAuth(await authClient.emailOtp.verifyEmail({ email, otp: code }));
      await refreshAuth(queryClient);
      const session = await queryClient.fetchQuery({
        queryKey: queryKeys.session(),
        queryFn: fetchSession,
      });
      toast.success('Email verified');
      if (session) {
        await navigate(next, { replace: true });
      } else {
        const nextQuery = next === '/' ? '' : `&next=${encodeURIComponent(next)}`;
        await navigate(`/login?email=${encodeURIComponent(email)}${nextQuery}`, { replace: true });
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Couldn’t verify the code.');
      setAttempt((current) => current + 1);
    } finally {
      setPending(false);
    }
  }

  async function resend() {
    setResending(true);
    setError(null);
    try {
      await sendVerificationCode(email);
      setAttempt((current) => current + 1);
      toast.success(`New code sent to ${email}`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Couldn’t send a new code.');
    } finally {
      setResending(false);
    }
  }

  return (
    <div className="grid gap-5">
      <div className="flex justify-center">
        <span className="flex size-12 items-center justify-center rounded-full bg-primary/10 text-primary">
          <MailCheckIcon className="size-6" aria-hidden="true" />
        </span>
      </div>
      <OtpInput
        key={attempt}
        onComplete={(code) => void verify(code)}
        disabled={pending}
        invalid={error !== null}
        autoFocus
        describedBy={error ? 'otp-error' : 'otp-hint'}
      />
      <p id="otp-hint" className="text-center text-xs text-muted-foreground">
        {pending ? (
          <span className="inline-flex items-center gap-1.5">
            <Spinner className="size-3" /> Checking…
          </span>
        ) : (
          `The code expires in ${OTP.expiresInSeconds / 60} minutes.`
        )}
      </p>
      {error ? (
        <div id="otp-error">
          <FormError message={error} />
        </div>
      ) : null}
      <div className="text-center text-sm text-muted-foreground">
        Didn’t get it? Check your spam folder, or{' '}
        <Button
          type="button"
          variant="link"
          className="h-auto p-0"
          disabled={cooldown > 0 || resending}
          onClick={() => void resend()}
        >
          {cooldown > 0 ? `resend in ${cooldown}s` : 'send a new code'}
        </Button>
        .
      </div>
    </div>
  );
}

function AskForEmail({ onEmail }: { onEmail: (email: string) => void }) {
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const parsed = emailSchema.safeParse(value.trim());
    if (!parsed.success) {
      setError('Enter a valid email address');
      return;
    }
    setPending(true);
    setError(null);
    try {
      await sendVerificationCode(parsed.data);
      onEmail(parsed.data);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Couldn’t send the code.');
    } finally {
      setPending(false);
    }
  }

  return (
    <form className="grid gap-4" onSubmit={(event) => void submit(event)} noValidate>
      <FormField label="Email" error={error}>
        {(field) => (
          <Input
            {...field}
            type="email"
            value={value}
            onChange={(event) => setValue(event.target.value)}
            autoComplete="email"
            autoFocus
          />
        )}
      </FormField>
      <Button type="submit" disabled={pending} className="w-full">
        {pending ? <Spinner /> : null}
        Send code
      </Button>
    </form>
  );
}

export default function VerifyEmailPage() {
  const [params] = useSearchParams();
  const next = safeNext(params.get('next'));
  const session = useSession();
  const me = useMe({ enabled: Boolean(session.data) });
  const [typedEmail, setTypedEmail] = useState<string | null>(null);
  const email = typedEmail ?? params.get('email') ?? me.data?.user.email ?? null;

  return (
    <AuthLayout
      title="Check your email"
      description={
        email ? (
          <>
            Enter the {OTP.length}-digit code we sent to{' '}
            <span className="font-medium text-foreground">{email}</span>.
          </>
        ) : (
          'Enter your email and we’ll send you a verification code.'
        )
      }
      footer={
        <>
          Wrong address?{' '}
          <Link to="/signup" className="font-medium text-foreground hover:underline">
            Sign up again
          </Link>{' '}
          or{' '}
          <Link to="/login" className="font-medium text-foreground hover:underline">
            log in
          </Link>
          .
        </>
      }
    >
      {email ? (
        <VerifyCode key={email} email={email} next={next} />
      ) : (
        <AskForEmail onEmail={setTypedEmail} />
      )}
    </AuthLayout>
  );
}
