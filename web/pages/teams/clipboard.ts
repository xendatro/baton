import { toast } from 'sonner';
import type { Invite } from '@shared/schemas/teams';

/** Absolute join URL of an invite, for copying. */
export function inviteLink(invite: Pick<Invite, 'code'>): string {
  return `${window.location.origin}/join/${invite.code}`;
}

/** Copies text, toasting the outcome. Returns whether it worked. */
export async function copyText(text: string, what = 'Link'): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    toast.success(`${what} copied`);
    return true;
  } catch {
    toast.error('Couldn’t copy. Select the text and copy it instead.');
    return false;
  }
}
