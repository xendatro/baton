import { useEffect, useRef } from 'react';
import { useLocation } from 'react-router';

/**
 * Scrolls to the element named by the URL hash (`#reply-<id>`) once `ready` (its content has
 * loaded) and briefly highlights it. Client-side navigation neither scrolls to late-rendered
 * anchors nor updates `:target`, so links such as search results and notifications need this.
 * Each hash is handled once per page visit, so later refetches don't yank the page back.
 */
export function useScrollToHash(ready: boolean): void {
  const { hash, key } = useLocation();
  const handled = useRef<string | null>(null);

  useEffect(() => {
    if (!ready || hash.length < 2) return;
    const visit = `${key}${hash}`;
    if (handled.current === visit) return;
    let id: string;
    try {
      id = decodeURIComponent(hash.slice(1));
    } catch {
      return;
    }
    const element = document.getElementById(id);
    if (!element) return;
    handled.current = visit;
    const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
    element.scrollIntoView?.({ block: 'center', behavior: reduceMotion ? 'auto' : 'smooth' });
    element.focus({ preventScroll: true });
    element.animate?.(
      [{ boxShadow: '0 0 0 3px var(--ring)' }, { boxShadow: '0 0 0 3px transparent' }],
      { duration: 2400, easing: 'ease-out' },
    );
  }, [ready, hash, key]);
}
