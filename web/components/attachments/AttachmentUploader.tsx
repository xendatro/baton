import { PaperclipIcon, UploadCloudIcon, XIcon } from 'lucide-react';
import { useRef, useState, type DragEvent } from 'react';
import type { AttachmentParentType } from '@shared/constants';
import type { Attachment } from '@shared/schemas/core';
import { Button } from '@web/components/ui/button';
import { errorMessage } from '@web/lib/api';
import { useConfig } from '@web/lib/auth';
import { formatBytes } from '@web/lib/format';
import { cn } from '@web/lib/utils';
import { uploadAttachment } from './upload';

interface UploadJob {
  id: number;
  file: File;
  progress: number;
  error: string | null;
  controller: AbortController;
}

export interface AttachmentUploaderProps {
  teamId: string;
  /** Defaults to `pending` (attach the ids when the item is saved). */
  parentType?: AttachmentParentType;
  parentId?: string;
  onUploaded: (attachment: Attachment) => void;
  multiple?: boolean;
  /** `button` only, or a `dropzone` with a button inside. */
  variant?: 'button' | 'dropzone';
  disabled?: boolean;
  className?: string;
}

let nextJobId = 1;

/** Upload button (and optional drop zone) with per-file progress, cancel and error display. */
export function AttachmentUploader({
  teamId,
  parentType = 'pending',
  parentId,
  onUploaded,
  multiple = true,
  variant = 'button',
  disabled = false,
  className,
}: AttachmentUploaderProps) {
  const config = useConfig();
  const input = useRef<HTMLInputElement>(null);
  const [jobs, setJobs] = useState<UploadJob[]>([]);
  const [dragging, setDragging] = useState(false);

  const update = (id: number, patch: Partial<UploadJob>) =>
    setJobs((current) => current.map((job) => (job.id === id ? { ...job, ...patch } : job)));
  const remove = (id: number) => setJobs((current) => current.filter((job) => job.id !== id));

  const start = (files: File[]) => {
    for (const file of multiple ? files : files.slice(0, 1)) {
      const job: UploadJob = {
        id: nextJobId++,
        file,
        progress: 0,
        error: null,
        controller: new AbortController(),
      };
      setJobs((current) => [...current, job]);
      uploadAttachment(file, {
        teamId,
        parentType,
        parentId,
        maxUploadMb: config.data?.maxUploadMb,
        signal: job.controller.signal,
        onProgress: (progress) => update(job.id, { progress }),
      })
        .then((attachment) => {
          remove(job.id);
          onUploaded(attachment);
        })
        .catch((error: unknown) => {
          if (error instanceof DOMException && error.name === 'AbortError') remove(job.id);
          else update(job.id, { error: errorMessage(error, 'Upload failed.') });
        });
    }
  };

  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragging(false);
    if (disabled) return;
    const files = Array.from(event.dataTransfer.files);
    if (files.length) start(files);
  };

  const button = (
    <Button
      type="button"
      variant={variant === 'dropzone' ? 'secondary' : 'outline'}
      size="sm"
      disabled={disabled}
      onClick={() => input.current?.click()}
    >
      <PaperclipIcon aria-hidden="true" />
      Attach files
    </Button>
  );

  return (
    <div className={cn('grid gap-2', className)}>
      {variant === 'dropzone' ? (
        <div
          onDragOver={(event) => {
            event.preventDefault();
            if (!disabled) setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={onDrop}
          className={cn(
            'flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed px-4 py-6 text-center text-sm text-muted-foreground transition-colors',
            dragging && 'border-primary bg-primary/5 text-foreground',
          )}
        >
          <UploadCloudIcon className="size-6" aria-hidden="true" />
          <p>
            Drop files here
            {config.data ? ` (up to ${config.data.maxUploadMb} MB each)` : ''}, or
          </p>
          {button}
        </div>
      ) : (
        <div>{button}</div>
      )}
      <input
        ref={input}
        type="file"
        multiple={multiple}
        hidden
        tabIndex={-1}
        aria-hidden="true"
        onChange={(event) => {
          const files = Array.from(event.target.files ?? []);
          event.target.value = '';
          if (files.length) start(files);
        }}
      />
      {jobs.length ? (
        <ul className="grid gap-1.5" aria-label="Uploads">
          {jobs.map((job) => (
            <li
              key={job.id}
              className="flex items-center gap-2 rounded-md border px-2.5 py-1.5 text-sm"
            >
              <div className="min-w-0 flex-1">
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate">{job.file.name}</span>
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {job.error ? formatBytes(job.file.size) : `${Math.round(job.progress * 100)}%`}
                  </span>
                </div>
                {job.error ? (
                  <p role="alert" className="text-xs text-destructive">
                    {job.error}
                  </p>
                ) : (
                  <div
                    role="progressbar"
                    aria-label={`Uploading ${job.file.name}`}
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={Math.round(job.progress * 100)}
                    className="mt-1 h-1 overflow-hidden rounded-full bg-muted"
                  >
                    <div
                      className="h-full rounded-full bg-primary transition-[width]"
                      style={{ width: `${job.progress * 100}%` }}
                    />
                  </div>
                )}
              </div>
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                aria-label={job.error ? `Dismiss ${job.file.name}` : `Cancel ${job.file.name}`}
                onClick={() => {
                  if (job.error) remove(job.id);
                  else job.controller.abort();
                }}
              >
                <XIcon aria-hidden="true" />
              </Button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
