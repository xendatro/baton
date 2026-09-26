import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogTitle,
} from '@web/components/ui/alert-dialog';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@web/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@web/components/ui/dropdown-menu';

/** A dialog opened through state, like the app's shell actions (no DialogTrigger). */
function ControlledDialog() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button">Before</button>
      <button type="button" onClick={() => setOpen(true)}>
        New task
      </button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogTitle>New task</DialogTitle>
          <DialogDescription>Create a task.</DialogDescription>
          {/* Like the New task dialog: a field that focuses itself as the dialog mounts. */}
          <input aria-label="Title" autoFocus />
        </DialogContent>
      </Dialog>
    </>
  );
}

function MenuDialog() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger>Actions</DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuItem onSelect={() => setOpen(true)}>Delete…</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <AlertDialog open={open} onOpenChange={setOpen}>
        <AlertDialogContent>
          <AlertDialogTitle>Delete?</AlertDialogTitle>
          <AlertDialogDescription>It goes to the Trash.</AlertDialogDescription>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction>Delete</AlertDialogAction>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

describe('dialogs return focus without a trigger (UX-02)', () => {
  it('focuses the button that opened a controlled dialog after Escape', async () => {
    const user = userEvent.setup();
    render(<ControlledDialog />);
    const opener = screen.getByRole('button', { name: 'New task' });
    await user.click(opener);
    await waitFor(() => expect(screen.getByLabelText('Title')).toHaveFocus());
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await waitFor(() => expect(opener).toHaveFocus());
  });

  it('focuses the button after the Close button', async () => {
    const user = userEvent.setup();
    render(<ControlledDialog />);
    const opener = screen.getByRole('button', { name: 'New task' });
    opener.focus();
    await user.keyboard('{Enter}');
    await user.click(await screen.findByRole('button', { name: 'Close' }));
    await waitFor(() => expect(opener).toHaveFocus());
  });

  it('returns to the menu trigger when a menu item opened the dialog', async () => {
    const user = userEvent.setup();
    render(<MenuDialog />);
    const trigger = screen.getByRole('button', { name: 'Actions' });
    await user.click(trigger);
    await user.click(await screen.findByRole('menuitem', { name: 'Delete…' }));
    await user.click(await screen.findByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
    await waitFor(() => expect(trigger).toHaveFocus());
  });
});
