import { useState, type FormEvent } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { toast } from 'sonner';
import { z } from 'zod';
import { OTP } from '@shared/constants';
import { emailSchema, passwordSchema } from '@shared/schemas/common';
import { fieldErrors } from '@web/lib/forms';
import { AuthLayout } from '@web/components/auth/AuthLayout';
import { FormError, FormField } from '@web/components/auth/FormField';
import { OtpInput } from '@web/components/auth/OtpInput';
import { sendPasswordResetCode, useResendCooldown } from '@web/components/auth/otp';
import { PasswordInput } from '@web/components/auth/PasswordInput';
import { PasswordStrengthMeter } from '@web/components/auth/PasswordStrengthMeter';
import { Spinner } from '@web/components/common/Spinner';
import { Button } from '@web/components/ui/button';
import { Input } from '@web/components/ui/input';
import { authClient, unwrapAuth } from '@web/lib/auth';

const resetSchema = z
  .object({
    email: z.string().trim().pipe(emailSchema),
    code: z
      .string()
      .regex(new RegExp(`^\\d{${OTP.length}}$`), `Enter the ${OTP.length}-digit code`),
    password: passwordSchema,
    confirm: z.string(),
  })
  .refine((value) => value.password === value.confirm, {
    message: 'The passwords don’t match',
    path: ['confirm'],
  });

type Field = 'email' | 'code' | 'password' | 'confirm';

export default function ResetPasswordPage() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const [email, setEmail] = useState(params.get('email') ?? '');
  const [code, setCode] = useState('');
  const [codeAttempt, setCodeAttempt] = useState(0);
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [errors, setErrors] = useState<Partial<Record<Field, string>>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const cooldown = useResendCooldown('forget-password', email.trim());

  async function submit(event: FormEvent) {
    event.preventDefault();
    const parsed = resetSchema.safeParse({ email, code, password, confirm });
    if (!parsed.success) {
      setErrors(fieldErrors<Field>(parsed.error));
      return;
    }
    setErrors({});
    setFormError(null);
    setPending(true);
    try {
      unwrapAuth(
        await authClient.emailOtp.resetPassword({
          email: parsed.data.email,
          otp: parsed.data.code,
          password: parsed.data.password,
        }),
      );
      toast.success('Password changed. Log in with your new password.');
      await navigate(`/login?email=${encodeURIComponent(parsed.data.email)}`, { replace: true });
    } catch (cause) {
      setFormError(cause instanceof Error ? cause.message : 'Couldn’t reset the password.');
      setCode('');
      setCodeAttempt((current) => current + 1);
    } finally {
      setPending(false);
    }
  }

  async function resend() {
    const parsed = emailSchema.safeParse(email.trim());
    if (!parsed.success) {
      setErrors({ email: 'Enter a valid email address' });
      return;
    }
    try {
      await sendPasswordResetCode(parsed.data);
      toast.success(`New code sent to ${parsed.data}`);
    } catch (cause) {
      setFormError(cause instanceof Error ? cause.message : 'Couldn’t send a new code.');
    }
  }

  return (
    <AuthLayout
      title="Choose a new password"
      description={`Enter the ${OTP.length}-digit code from the email and a new password.`}
      footer={
        <Link to="/login" className="font-medium text-foreground hover:underline">
          Back to log in
        </Link>
      }
    >
      <form className="grid gap-4" onSubmit={(event) => void submit(event)} noValidate>
        <FormField label="Email" error={errors.email}>
          {(field) => (
            <Input
              {...field}
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              autoComplete="email"
              autoCapitalize="none"
            />
          )}
        </FormField>
        <div className="grid gap-1.5">
          <div className="flex items-center justify-between gap-2">
            <span className="text-sm leading-none font-medium" id="reset-code-label">
              Code
            </span>
            <Button
              type="button"
              variant="link"
              size="xs"
              className="h-auto p-0 text-xs text-muted-foreground"
              disabled={cooldown > 0}
              onClick={() => void resend()}
            >
              {cooldown > 0 ? `Resend in ${cooldown}s` : 'Send a new code'}
            </Button>
          </div>
          <OtpInput
            key={codeAttempt}
            onChange={setCode}
            invalid={Boolean(errors.code)}
            label="Reset code"
            describedBy={errors.code ? 'reset-code-error' : undefined}
          />
          {errors.code ? (
            <p id="reset-code-error" role="alert" className="text-xs text-destructive">
              {errors.code}
            </p>
          ) : null}
        </div>
        <FormField label="New password" error={errors.password}>
          {(field) => (
            <div className="grid gap-2">
              <PasswordInput
                {...field}
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                autoComplete="new-password"
              />
              <PasswordStrengthMeter password={password} />
            </div>
          )}
        </FormField>
        <FormField label="Confirm new password" error={errors.confirm}>
          {(field) => (
            <PasswordInput
              {...field}
              value={confirm}
              onChange={(event) => setConfirm(event.target.value)}
              autoComplete="new-password"
            />
          )}
        </FormField>
        <FormError message={formError} />
        <Button type="submit" disabled={pending} className="w-full">
          {pending ? <Spinner /> : null}
          Change password
        </Button>
      </form>
    </AuthLayout>
  );
}
