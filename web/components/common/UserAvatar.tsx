import { Avatar, AvatarFallback, AvatarImage } from '@web/components/ui/avatar';
import { hueFromString, initials } from '@web/lib/format';
import { cn } from '@web/lib/utils';

export interface AvatarUser {
  id: string;
  name: string;
  username?: string | null;
  image?: string | null;
}

const SIZES = {
  xs: 'size-4',
  sm: 'size-5',
  md: 'size-6',
  lg: 'size-8',
  xl: 'size-12',
} as const;

/** Initials text per size (the fallback has its own text size, so it is set there). */
const TEXT = {
  xs: 'text-[0.5rem]',
  sm: 'text-[0.55rem]',
  md: 'text-[0.6rem]',
  lg: 'text-xs',
  xl: 'text-base',
} as const;

export type AvatarSize = keyof typeof SIZES;

export interface UserAvatarProps {
  /** Null renders a neutral placeholder for deleted users. */
  user: AvatarUser | null;
  size?: AvatarSize;
  className?: string;
}

/** Profile picture, or initials on a color derived from the user id. */
export function UserAvatar({ user, size = 'md', className }: UserAvatarProps) {
  const label = user ? user.name || user.username || 'User' : 'Deleted user';
  const hue = user ? hueFromString(user.id) : 0;
  return (
    <Avatar className={cn(SIZES[size], className)} aria-hidden="true" title={label}>
      {user?.image ? <AvatarImage src={user.image} alt="" referrerPolicy="no-referrer" /> : null}
      <AvatarFallback
        className={cn('leading-none font-semibold tracking-tight text-white', TEXT[size])}
        style={{
          backgroundColor: user ? `oklch(0.55 0.13 ${hue})` : 'var(--muted-foreground)',
        }}
      >
        {user ? initials(user.name, user.username ?? '?').slice(0, size === 'xs' ? 1 : 2) : '?'}
      </AvatarFallback>
    </Avatar>
  );
}

export interface AvatarStackProps {
  users: readonly AvatarUser[];
  /** Avatars shown before collapsing the rest into "+N". */
  max?: number;
  size?: AvatarSize;
  className?: string;
}

/** Overlapping avatars with a "+N" overflow count. */
export function AvatarStack({ users, max = 3, size = 'md', className }: AvatarStackProps) {
  const shown = users.slice(0, max);
  const hidden = users.length - shown.length;
  const names = users.map((user) => user.name).join(', ');
  return (
    <span className={cn('inline-flex items-center -space-x-1.5', className)} title={names}>
      <span className="sr-only">{names}</span>
      {shown.map((user) => (
        <UserAvatar key={user.id} user={user} size={size} className="ring-2 ring-background" />
      ))}
      {hidden > 0 ? (
        <span
          aria-hidden="true"
          className={cn(
            SIZES[size],
            TEXT[size],
            'relative inline-flex shrink-0 items-center justify-center rounded-full bg-muted font-medium text-muted-foreground ring-2 ring-background',
          )}
        >
          +{hidden}
        </span>
      ) : null}
    </span>
  );
}
