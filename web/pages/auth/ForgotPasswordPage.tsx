import { useState, type FormEvent } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { emailSchema } from '@shared/schemas/common';
import { AuthLayout } from '@web/components/auth/AuthLayout';
import { FormError, FormField } from '@web/components/auth/FormField';
import { sendPasswordResetCode } from '@web/components/auth/otp';
import { Spinner } from '@web/components/common/Spinner';
import { Button } from '@web/components/ui/button';
import { Input } from '@web/components/ui/input';

export default function ForgotPasswordPage() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const [email, setEmail] = useState(params.get('email') ?? '');
  const [error, setError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const parsed = emailSchema.safeParse(email.trim());
    if (!parsed.success) {
      setError('Enter a valid email address');
      return;
    }
    setError(null);
    setFormError(null);
    setPending(true);
    try {
      await sendPasswordResetCode(parsed.data);
      await navigate(`/reset-password?email=${encodeURIComponent(parsed.data)}`);
    } catch (cause) {
      setFormError(cause instanceof Error ? cause.message : 'Couldn’t send the code.');
    } finally {
      setPending(false);
    }
  }

  return (
    <AuthLayout
      title="Reset your password"
      description="Enter your account’s email and we’ll send you a code to choose a new password."
      footer={
        <Link to="/login" className="font-medium text-foreground hover:underline">
          Back to log in
        </Link>
      }
    >
      <form className="grid gap-4" onSubmit={(event) => void submit(event)} noValidate>
        <FormField label="Email" error={error}>
          {(field) => (
            <Input
              {...field}
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              autoComplete="email"
              autoCapitalize="none"
              spellCheck={false}
              autoFocus
            />
          )}
        </FormField>
        <FormError message={formError} />
        <Button type="submit" disabled={pending} className="w-full">
          {pending ? <Spinner /> : null}
          Send reset code
        </Button>
      </form>
    </AuthLayout>
  );
}
