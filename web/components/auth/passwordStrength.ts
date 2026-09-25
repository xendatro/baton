import { LIMITS } from '@shared/constants';

export interface PasswordStrength {
  /** 0 (too short) to 4 (strong). */
  score: 0 | 1 | 2 | 3 | 4;
  label: string;
  hint: string;
}

const COMMON = [
  'password',
  '12345678',
  '123456789',
  'qwertyui',
  'iloveyou',
  'baton123',
  'letmein1',
  'welcome1',
];

/**
 * Rough strength estimate for the sign-up hint (the server only enforces the length). Rewards
 * length and character variety; penalises repeats and common passwords.
 */
export function passwordStrength(password: string): PasswordStrength {
  if (password.length < LIMITS.password.min) {
    return {
      score: 0,
      label: 'Too short',
      hint: `Use at least ${LIMITS.password.min} characters.`,
    };
  }
  const lower = password.toLowerCase();
  if (COMMON.some((common) => lower.includes(common)) || /^(.)\1+$/.test(password)) {
    return { score: 1, label: 'Weak', hint: 'Avoid common words and repeated characters.' };
  }
  const variety = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((re) => re.test(password)).length;
  let points = variety;
  if (password.length >= 12) points += 1;
  if (password.length >= 16) points += 1;
  if (points <= 2) {
    return { score: 1, label: 'Weak', hint: 'Add length, or mix in numbers and symbols.' };
  }
  if (points === 3) return { score: 2, label: 'Fair', hint: 'Longer is stronger.' };
  if (points === 4) return { score: 3, label: 'Good', hint: 'Nice. A passphrase is even better.' };
  return { score: 4, label: 'Strong', hint: 'Great password.' };
}
