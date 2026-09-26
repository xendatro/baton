import { useLayoutEffect, useRef, useState } from 'react';
import { captureReturnTarget, trackOpenDialog, type ReturnTarget } from './returnFocus';

/**
 * Rendered inside a dialog's content (by `useReturnFocus`): reads the focused element while the
 * content first renders, before anything inside it autofocuses, and reports it.
 */
export function CaptureFocus({ onCapture }: { onCapture: (target: ReturnTarget) => void }) {
  const [target] = useState(() => captureReturnTarget(document.activeElement));
  const report = useRef(onCapture);
  useLayoutEffect(() => {
    report.current(target);
    return trackOpenDialog(target);
  }, [target]);
  return null;
}
