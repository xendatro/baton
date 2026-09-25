import { useEffect, useState, type RefObject } from 'react';

export interface InViewOptions {
  /** Grows or shrinks the viewport, e.g. `'0px 0px 400px 0px'` to see the end of a list coming. */
  rootMargin?: string;
  /** Observe only while true (e.g. once the element is rendered). */
  enabled?: boolean;
  /** The answer before the first observation, and without IntersectionObserver. */
  initial?: boolean;
}

/** Whether the element is visible in the (adjusted) viewport. */
export function useInView(
  ref: RefObject<Element | null>,
  { rootMargin = '0px', enabled = true, initial = false }: InViewOptions = {},
): boolean {
  const [inView, setInView] = useState(initial);
  useEffect(() => {
    const element = ref.current;
    if (!enabled || !element || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver(
      (records) => {
        const last = records.at(-1);
        if (last) setInView(last.isIntersecting);
      },
      { rootMargin },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref, rootMargin, enabled]);
  return inView;
}
