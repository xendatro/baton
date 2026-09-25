import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { Attachment } from '@shared/schemas/core';
import { AttachmentList } from './AttachmentList';

const file: Attachment = {
  id: 'a1',
  teamId: 't1',
  parentType: 'pending',
  parentId: null,
  filename: 'notes.txt',
  mimeType: 'text/plain',
  size: 12,
  isImage: false,
  url: '/api/attachments/a1/notes.txt',
  uploader: null,
  via: null,
  createdAt: '2026-09-25T10:00:00.000Z',
};

describe('AttachmentList', () => {
  it('confirms before moving a saved file to Trash', async () => {
    const onDelete = vi.fn();
    const user = userEvent.setup();
    render(<AttachmentList attachments={[file]} canDelete={() => true} onDelete={onDelete} />);
    await user.click(screen.getByRole('button', { name: 'Delete notes.txt' }));
    expect(await screen.findByText(/moves to Trash/)).toBeInTheDocument();
    expect(onDelete).not.toHaveBeenCalled();
  });

  // Regression (WEB-13): removing a file from an unsent draft claimed it would go to Trash.
  it('removes a draft file at once, without the Trash confirmation', async () => {
    const onDelete = vi.fn();
    const user = userEvent.setup();
    render(
      <AttachmentList
        attachments={[file]}
        removeMode="draft"
        canDelete={() => true}
        onDelete={onDelete}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Remove notes.txt' }));
    expect(onDelete).toHaveBeenCalledWith(file);
    expect(screen.queryByText(/Trash/)).not.toBeInTheDocument();
  });
});
