import { inviteCodeSchema } from '@shared/schemas/teams';

/**
 * The invite code in what someone pasted: a code (`AbCd123456`), a full invite link
 * (`https://baton.example/join/AbCd123456`) or its path. Null when there is none.
 */
export function parseInviteInput(input: string): string | null {
  const value = input.trim();
  if (!value) return null;
  if (inviteCodeSchema.safeParse(value).success) return value;
  const match = /(?:^|\/)join\/([0-9A-Za-z]{10})(?:[/?#]|$)/.exec(value);
  return match?.[1] ?? null;
}

/** "Good morning" until noon, "Good afternoon" until 6 pm, then "Good evening". */
export function greeting(now: Date): string {
  const hour = now.getHours();
  if (hour >= 5 && hour < 12) return 'Good morning';
  if (hour >= 12 && hour < 18) return 'Good afternoon';
  return 'Good evening';
}

/** The first word of a display name ("Ada Lovelace" → "Ada"). */
export function firstName(name: string): string {
  return name.trim().split(/\s+/)[0] ?? name;
}
