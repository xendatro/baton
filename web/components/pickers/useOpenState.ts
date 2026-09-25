import { useState } from 'react';

/** Open state that is controlled when `open` is passed (e.g. opened by a hotkey), else internal. */
export function useOpenState(
  open: boolean | undefined,
  onOpenChange: ((open: boolean) => void) | undefined,
): [boolean, (open: boolean) => void] {
  const [inner, setInner] = useState(false);
  const current = open ?? inner;
  const setOpen = (next: boolean) => {
    if (open === undefined) setInner(next);
    onOpenChange?.(next);
  };
  return [current, setOpen];
}
