import { Link } from 'react-router';
import { formatIssueRef, formatTaskRef } from '@shared/refs';
import { cn } from '@web/lib/utils';

export interface TaskKeyProps {
  projectKey: string;
  number: number;
  /** `task` → `KEY-12`, `issue` → `KEY#51`. */
  kind?: 'task' | 'issue';
  /** Makes the key a link. */
  to?: string;
  className?: string;
}

/** Monospaced task (`KEY-12`) or issue (`KEY#51`) reference. */
export function TaskKey({ projectKey, number, kind = 'task', to, className }: TaskKeyProps) {
  const text =
    kind === 'task' ? formatTaskRef(projectKey, number) : formatIssueRef(projectKey, number);
  const classes = cn(
    'shrink-0 font-mono text-xs whitespace-nowrap text-muted-foreground tabular-nums',
    to && 'rounded-sm hover:text-foreground hover:underline',
    className,
  );
  return to ? (
    <Link to={to} className={classes}>
      {text}
    </Link>
  ) : (
    <span className={classes}>{text}</span>
  );
}
