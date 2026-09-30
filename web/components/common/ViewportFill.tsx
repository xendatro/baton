import { useLayoutEffect, useRef, useState, type ComponentProps, type RefObject } from 'react';
import { cn } from '@web/lib/utils';

/**
 * BAT-43/44: a box exactly as tall as the viewport below where it starts, whatever sits above it
 * (the app header, the project header). `page`: measured from the top of the document, for a page
 * that must not scroll. `sticky`: a sticky column (the item rail), measured from where it sits now
 * but never above `stickyTop`, so it fills the screen before and after it sticks. The class names
 * give the fallback height until the first measurement.
 */
export function ViewportFill({
  mode = 'page',
  stickyTop = 48,
  className,
  style,
  ...props
}: ComponentProps<'div'> & { mode?: 'page' | 'sticky'; stickyTop?: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const height = useRemainingHeight(ref, mode, stickyTop);
  return (
    <div
      ref={ref}
      className={cn(className)}
      style={height === null ? style : { ...style, height }}
      {...props}
    />
  );
}

function useRemainingHeight(
  ref: RefObject<HTMLElement | null>,
  mode: 'page' | 'sticky',
  stickyTop: number,
): number | null {
  const [height, setHeight] = useState<number | null>(null);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const update = () => {
      const rect = element.getBoundingClientRect();
      const top = mode === 'page' ? rect.top + window.scrollY : Math.max(rect.top, stickyTop);
      setHeight(Math.max(0, Math.floor(window.innerHeight - top)));
    };
    update();
    window.addEventListener('resize', update);
    if (mode === 'sticky') window.addEventListener('scroll', update, { passive: true });
    // Whatever is above may change height (a notice appears, the project header wraps).
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(update);
    observer?.observe(document.body);
    return () => {
      window.removeEventListener('resize', update);
      window.removeEventListener('scroll', update);
      observer?.disconnect();
    };
  }, [ref, mode, stickyTop]);
  return height;
}
