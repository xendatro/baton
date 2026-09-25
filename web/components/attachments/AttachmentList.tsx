import { DownloadIcon, Trash2Icon } from 'lucide-react';
import { useState } from 'react';
import type { Attachment } from '@shared/schemas/core';
import { ConfirmDialog } from '@web/components/common/ConfirmDialog';
import { Button } from '@web/components/ui/button';
import { formatBytes } from '@web/lib/format';
import { cn } from '@web/lib/utils';
import { fileIcon } from './fileIcon';

export interface AttachmentListProps {
  attachments: readonly Attachment[];
  /** Shows a delete button for attachments this returns true for. */
  canDelete?: (attachment: Attachment) => boolean;
  /** Called after the user confirms; may be async (the dialog waits and shows errors). */
  onDelete?: (attachment: Attachment) => void | Promise<void>;
  className?: string;
}

/** Image thumbnails and file rows with icon, size, download and (when allowed) delete. */
export function AttachmentList({
  attachments,
  canDelete,
  onDelete,
  className,
}: AttachmentListProps) {
  const [pending, setPending] = useState<Attachment | null>(null);
  if (attachments.length === 0) return null;
  const deletable = (attachment: Attachment) =>
    Boolean(onDelete) && (canDelete ? canDelete(attachment) : false);

  return (
    <>
      <ul className={cn('grid gap-2 sm:grid-cols-2', className)} aria-label="Attachments">
        {attachments.map((attachment) => {
          const Icon = fileIcon(attachment.mimeType, attachment.filename);
          return (
            <li
              key={attachment.id}
              className="group flex min-w-0 items-center gap-3 rounded-md border bg-card p-2"
            >
              {attachment.isImage ? (
                <a
                  href={attachment.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="shrink-0"
                  aria-label={`Open ${attachment.filename}`}
                >
                  <img
                    src={attachment.url}
                    alt=""
                    loading="lazy"
                    className="size-10 rounded border object-cover"
                  />
                </a>
              ) : (
                <span className="flex size-10 shrink-0 items-center justify-center rounded border bg-muted text-muted-foreground">
                  <Icon className="size-5" aria-hidden="true" />
                </span>
              )}
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium" title={attachment.filename}>
                  {attachment.filename}
                </p>
                <p className="text-xs text-muted-foreground">{formatBytes(attachment.size)}</p>
              </div>
              <div className="flex shrink-0 items-center gap-0.5">
                <Button asChild variant="ghost" size="icon-sm">
                  <a
                    href={attachment.url}
                    download={attachment.filename}
                    aria-label={`Download ${attachment.filename}`}
                    title="Download"
                  >
                    <DownloadIcon aria-hidden="true" />
                  </a>
                </Button>
                {deletable(attachment) ? (
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={`Delete ${attachment.filename}`}
                    title="Delete"
                    onClick={() => setPending(attachment)}
                  >
                    <Trash2Icon aria-hidden="true" />
                  </Button>
                ) : null}
              </div>
            </li>
          );
        })}
      </ul>
      <ConfirmDialog
        open={pending !== null}
        onOpenChange={(open) => {
          if (!open) setPending(null);
        }}
        title="Delete attachment?"
        description={
          pending
            ? `“${pending.filename}” moves to Trash and can be restored for 30 days.`
            : undefined
        }
        confirmLabel="Delete"
        destructive
        onConfirm={async () => {
          if (pending && onDelete) await onDelete(pending);
        }}
      />
    </>
  );
}
