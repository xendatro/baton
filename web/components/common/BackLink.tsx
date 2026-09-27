import { ArrowLeftIcon } from 'lucide-react';
import type { MouseEvent } from 'react';
import { Link } from 'react-router';
import { useHotkey } from '@web/lib/hotkeys';
import { useBack, type BackOptions } from '@web/lib/navigationHistory';
import { cn } from '@web/lib/utils';

export interface BackLinkProps extends BackOptions {
  /** Bind `u` to the link (default true). */
  hotkey?: boolean;
  className?: string;
}

/**
 * "← Issues" above a detail page's title (BAT-11): back to the list the page was opened from with
 * its filters and scroll position, or to the section's list when opened directly. `u` follows it.
 * A modified click (new tab) opens the list's URL.
 */
export function BackLink({ hotkey = true, className, ...options }: BackLinkProps) {
  const { href, label, goBack } = useBack(options);
  useHotkey('u', goBack, { description: `Back to ${label}`, group: 'Navigation', enabled: hotkey });

  const onClick = (event: MouseEvent<HTMLAnchorElement>) => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
      return;
    }
    event.preventDefault();
    goBack();
  };

  return (
    <Link
      to={href}
      onClick={onClick}
      aria-label={`Back to ${label}`}
      aria-keyshortcuts={hotkey ? 'u' : undefined}
      className={cn(
        'mb-3 inline-flex max-w-full items-center gap-1.5 rounded-sm text-sm text-muted-foreground outline-none hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50',
        className,
      )}
    >
      <ArrowLeftIcon className="size-4 shrink-0" aria-hidden="true" />
      <span className="truncate">{label}</span>
    </Link>
  );
}
