import { useEffect, useRef } from 'react';
import { useBeforeUnload, useBlocker } from 'react-router';
import { ConfirmDialog } from '@web/components/common/ConfirmDialog';

/**
 * Asks before leaving a page with unsaved changes (in-app navigation and closing the tab).
 * Returns `allowNavigation`, to call right before a navigation the page starts itself after
 * saving (e.g. to a renamed URL).
 */
export function useUnsavedChangesGuard(dirty: boolean) {
  const dirtyRef = useRef(dirty);
  useEffect(() => {
    dirtyRef.current = dirty;
  }, [dirty]);
  const blocker = useBlocker(
    ({ currentLocation, nextLocation }) =>
      dirtyRef.current && currentLocation.pathname !== nextLocation.pathname,
  );
  useBeforeUnload((event) => {
    if (dirtyRef.current) event.preventDefault();
  });
  const dialog = (
    <ConfirmDialog
      open={blocker.state === 'blocked'}
      onOpenChange={(open) => {
        if (!open && blocker.state === 'blocked') blocker.reset();
      }}
      title="Discard unsaved changes?"
      description="You have changes on this page that haven’t been saved."
      confirmLabel="Discard"
      cancelLabel="Keep editing"
      destructive
      onConfirm={() => {
        if (blocker.state === 'blocked') blocker.proceed();
      }}
    />
  );
  return {
    dialog,
    allowNavigation: () => {
      dirtyRef.current = false;
    },
  };
}
