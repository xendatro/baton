import { ChevronDownIcon, ChevronUpIcon } from 'lucide-react';
import { useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { Button } from '@web/components/ui/button';
import { cn } from '@web/lib/utils';

/**
 * BAT-43: long content cut to a few lines with "Read more", which expands it inline ("Show less"
 * collapses it again). Short content shows whole, without the button. `disabled` shows it whole
 * (e.g. while it is being edited).
 */
export function ReadMore({
  children,
  collapsedHeight = 112,
  disabled = false,
  fadeClassName = 'from-background',
  className,
}: {
  children: ReactNode;
  /** Height of the cut, in pixels. */
  collapsedHeight?: number;
  disabled?: boolean;
  /** The fade's colour: the background behind the content. */
  fadeClassName?: string;
  className?: string;
}) {
  const id = useId();
  const content = useRef<HTMLDivElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [overflows, setOverflows] = useState(false);

  useLayoutEffect(() => {
    const element = content.current;
    if (!element) return;
    // A little slack, so content just over the cut isn't hidden behind a button.
    const measure = () => setOverflows(element.scrollHeight > collapsedHeight + 24);
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [collapsedHeight]);

  const clamped = !disabled && !expanded && overflows;
  return (
    <div className={className}>
      <div
        id={id}
        className={cn('relative', clamped && 'overflow-hidden')}
        style={clamped ? { maxHeight: collapsedHeight } : undefined}
        data-testid="read-more-content"
        data-clamped={clamped ? '' : undefined}
      >
        <div ref={content}>{children}</div>
        {clamped ? (
          <div
            aria-hidden="true"
            className={cn(
              'pointer-events-none absolute inset-x-0 bottom-0 h-10 bg-gradient-to-t to-transparent',
              fadeClassName,
            )}
          />
        ) : null}
      </div>
      {overflows && !disabled ? (
        <Button
          variant="ghost"
          size="sm"
          className="mt-1 h-7 px-2 text-xs text-muted-foreground"
          aria-expanded={expanded}
          aria-controls={id}
          onClick={() => setExpanded((open) => !open)}
        >
          {expanded ? <ChevronUpIcon aria-hidden="true" /> : <ChevronDownIcon aria-hidden="true" />}
          {expanded ? 'Show less' : 'Read more'}
        </Button>
      ) : null}
    </div>
  );
}
