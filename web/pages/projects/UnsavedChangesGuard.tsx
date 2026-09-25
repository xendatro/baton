import { useEffect } from 'react';
import { useBlocker } from 'react-router';
import { ConfirmDialog } from '@web/components/common/ConfirmDialog';

/**
 * Asks before leaving a page with unsaved edits: in-app navigation shows a confirm dialog, and
 * closing or reloading the tab triggers the browser's own prompt.
 */
export function UnsavedChangesGuard({ when, what = 'changes' }: { when: boolean; what?: string }) {
  const blocker = useBlocker(
    ({ currentLocation, nextLocation }) =>
      when && currentLocation.pathname !== nextLocation.pathname,
  );

  useEffect(() => {
    if (!when) return;
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [when]);

  return (
    <ConfirmDialog
      open={blocker.state === 'blocked'}
      onOpenChange={(open) => {
        if (!open && blocker.state === 'blocked') blocker.reset();
      }}
      title={`Discard unsaved ${what}?`}
      description="You have edits that haven’t been saved. Leaving this page discards them."
      confirmLabel="Discard and leave"
      cancelLabel="Keep editing"
      destructive
      onConfirm={() => {
        if (blocker.state === 'blocked') blocker.proceed();
      }}
    />
  );
}
