import { useId, useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import { z } from 'zod';
import { LIMITS } from '@shared/constants';
import { passwordSchema } from '@shared/schemas/common';
import { FormError, FormField } from '@web/components/auth/FormField';
import { PasswordInput } from '@web/components/auth/PasswordInput';
import { PasswordStrengthMeter } from '@web/components/auth/PasswordStrengthMeter';
import { Spinner } from '@web/components/common/Spinner';
import { Button } from '@web/components/ui/button';
import { Checkbox } from '@web/components/ui/checkbox';
import { Label } from '@web/components/ui/label';
import { errorMessage, isApiError } from '@web/lib/api';
import { fieldErrors } from '@web/lib/forms';
import { pluralize } from '@web/lib/format';
import { useChangePassword, useSetPassword } from './queries';
import { SettingsCard } from './SettingsCard';

type Field = 'currentPassword' | 'newPassword' | 'confirm';

const newPasswordFields = {
  newPassword: passwordSchema,
  confirm: z.string(),
};

function matchConfirm<T extends { newPassword: string; confirm: string }>(schema: z.ZodType<T>) {
  return schema.refine((value) => value.newPassword === value.confirm, {
    message: 'The passwords don’t match',
    path: ['confirm'],
  });
}

const changeSchema = matchConfirm(
  z.object({
    currentPassword: z.string().min(1, 'Enter your current password'),
    ...newPasswordFields,
  }),
);
const setSchema = matchConfirm(z.object(newPasswordFields));

function revokedMessage(count: number): string {
  return count > 0 ? ` ${pluralize(count, 'other session')} signed out.` : '';
}

/**
 * Change the password (current + new), or set one for accounts that only sign in with Google or
 * GitHub. Either can sign out every other session.
 */
export function PasswordCard({ hasPassword, email }: { hasPassword: boolean; email: string }) {
  const id = useId();
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [revokeOtherSessions, setRevokeOtherSessions] = useState(true);
  const [errors, setErrors] = useState<Partial<Record<Field, string>>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const change = useChangePassword();
  const set = useSetPassword();
  const pending = change.isPending || set.isPending;

  function reset() {
    setCurrentPassword('');
    setNewPassword('');
    setConfirm('');
  }

  function onError(cause: unknown) {
    const fields = isApiError(cause) ? cause.fieldErrors : {};
    if (fields.currentPassword || fields.newPassword) {
      setErrors({ currentPassword: fields.currentPassword, newPassword: fields.newPassword });
    } else {
      setFormError(errorMessage(cause));
    }
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    setFormError(null);
    if (hasPassword) {
      const parsed = changeSchema.safeParse({ currentPassword, newPassword, confirm });
      if (!parsed.success) {
        setErrors(fieldErrors<Field>(parsed.error));
        return;
      }
      setErrors({});
      change.mutate(
        { currentPassword, newPassword, revokeOtherSessions },
        {
          onSuccess: (result) => {
            reset();
            toast.success(`Password changed.${revokedMessage(result.revokedSessions)}`);
          },
          onError,
        },
      );
    } else {
      const parsed = setSchema.safeParse({ newPassword, confirm });
      if (!parsed.success) {
        setErrors(fieldErrors<Field>(parsed.error));
        return;
      }
      setErrors({});
      set.mutate(
        { newPassword, revokeOtherSessions },
        {
          onSuccess: (result) => {
            reset();
            toast.success(
              `Password set. You can now sign in with your email.${revokedMessage(result.revokedSessions)}`,
            );
          },
          onError,
        },
      );
    }
  }

  return (
    <form onSubmit={submit} noValidate aria-labelledby={`${id}-title`}>
      <SettingsCard
        title={<span id={`${id}-title`}>{hasPassword ? 'Change password' : 'Set a password'}</span>}
        description={
          hasPassword
            ? 'Use a long passphrase you don’t use anywhere else.'
            : 'You sign in with Google or GitHub. Add a password to also sign in with your email.'
        }
        footer={
          <>
            <div className="flex items-center gap-2">
              <Checkbox
                id={`${id}-revoke`}
                checked={revokeOtherSessions}
                onCheckedChange={(value) => setRevokeOtherSessions(value === true)}
              />
              <Label htmlFor={`${id}-revoke`} className="text-xs font-normal">
                Sign out of all other sessions
              </Label>
            </div>
            <Button type="submit" size="sm" disabled={pending}>
              {pending ? <Spinner /> : null}
              {hasPassword ? 'Change password' : 'Set password'}
            </Button>
          </>
        }
      >
        <div className="grid max-w-sm gap-4">
          {/* Tells password managers which account the new password belongs to. */}
          <input
            type="text"
            name="username"
            autoComplete="username"
            value={email}
            readOnly
            hidden
          />
          {hasPassword ? (
            <FormField label="Current password" error={errors.currentPassword}>
              {(field) => (
                <PasswordInput
                  {...field}
                  value={currentPassword}
                  onChange={(event) => setCurrentPassword(event.target.value)}
                  autoComplete="current-password"
                  maxLength={LIMITS.password.max}
                />
              )}
            </FormField>
          ) : null}
          <FormField
            label="New password"
            error={errors.newPassword}
            hint={`At least ${LIMITS.password.min} characters.`}
          >
            {(field) => (
              <div className="grid gap-2">
                <PasswordInput
                  {...field}
                  value={newPassword}
                  onChange={(event) => setNewPassword(event.target.value)}
                  autoComplete="new-password"
                  maxLength={LIMITS.password.max}
                />
                <PasswordStrengthMeter password={newPassword} />
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
                maxLength={LIMITS.password.max}
              />
            )}
          </FormField>
          <FormError message={formError} />
        </div>
      </SettingsCard>
    </form>
  );
}
