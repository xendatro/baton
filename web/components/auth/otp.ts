import { useEffect, useState } from 'react';
import { OTP } from '@shared/constants';
import { authClient, unwrapAuth } from '@web/lib/auth';

/**
 * Emailed one-time codes (verification and password reset). The resend cooldown is remembered
 * per email for the browser tab, so reloading the page doesn't allow an early resend.
 */

export type OtpPurpose = 'email-verification' | 'forget-password';

function storageKey(purpose: OtpPurpose, email: string): string {
  return `baton-otp-sent:${purpose}:${email.toLowerCase()}`;
}

export function markCodeSent(purpose: OtpPurpose, email: string, at = Date.now()): void {
  try {
    sessionStorage.setItem(storageKey(purpose, email), String(at));
  } catch {
    // Storage unavailable: the cooldown only lasts for this page view.
  }
}

function lastSentAt(purpose: OtpPurpose, email: string): number {
  try {
    return Number(sessionStorage.getItem(storageKey(purpose, email)) ?? 0) || 0;
  } catch {
    return 0;
  }
}

/** Sends a verification code to `email` (Better Auth email OTP) and starts the cooldown. */
export async function sendVerificationCode(email: string): Promise<void> {
  unwrapAuth(await authClient.emailOtp.sendVerificationOtp({ email, type: 'email-verification' }));
  markCodeSent('email-verification', email);
}

/** Sends a password-reset code to `email` and starts the cooldown. */
export async function sendPasswordResetCode(email: string): Promise<void> {
  unwrapAuth(await authClient.emailOtp.requestPasswordReset({ email }));
  markCodeSent('forget-password', email);
}

/** Seconds until a new code may be requested (ticks down once a second). */
export function useResendCooldown(purpose: OtpPurpose, email: string): number {
  const compute = () => {
    const elapsed = (Date.now() - lastSentAt(purpose, email)) / 1000;
    return Math.max(0, Math.ceil(OTP.resendCooldownSeconds - elapsed));
  };
  const [seconds, setSeconds] = useState(compute);
  useEffect(() => {
    const tick = () => {
      const elapsed = (Date.now() - lastSentAt(purpose, email)) / 1000;
      setSeconds(Math.max(0, Math.ceil(OTP.resendCooldownSeconds - elapsed)));
    };
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [purpose, email]);
  return seconds;
}
