import { AtSignIcon, ImageUpIcon, Trash2Icon, TriangleAlertIcon } from 'lucide-react';
import { useEffect, useId, useRef, useState, type DragEvent, type FormEvent } from 'react';
import { toast } from 'sonner';
import { LIMITS } from '@shared/constants';
import { AVATAR_MAX_BYTES, AVATAR_MIME_TYPES } from '@shared/schemas/account';
import { displayNameSchema, usernameSchema } from '@shared/schemas/common';
import type { MeUser } from '@shared/schemas/core';
import { FormField } from '@web/components/auth/FormField';
import { UsernameField } from '@web/components/auth/UsernameField';
import { useUsernameAvailability } from '@web/components/auth/useUsernameAvailability';
import { ErrorState } from '@web/components/common/ErrorState';
import { Spinner } from '@web/components/common/Spinner';
import { Avatar, AvatarFallback, AvatarImage } from '@web/components/ui/avatar';
import { Button } from '@web/components/ui/button';
import { Input } from '@web/components/ui/input';
import { errorMessage, isApiError } from '@web/lib/api';
import { useConfig, useMe } from '@web/lib/auth';
import { hueFromString, initials } from '@web/lib/format';
import { cn } from '@web/lib/utils';
import { useRemoveAvatar, useUpdateProfile, useUploadAvatar } from './queries';
import { SettingsCard, SettingsCardSkeleton, SettingsPage } from './SettingsCard';

const ACCEPTED_TYPES: readonly string[] = AVATAR_MIME_TYPES;

function formatMb(bytes: number): string {
  return `${Math.floor(bytes / 1024 / 1024)} MB`;
}

// ---------------------------------------------------------------------------------------------
// Avatar
// ---------------------------------------------------------------------------------------------

function LargeAvatar({ user, src }: { user: MeUser; src: string | null }) {
  return (
    <Avatar className="size-20 ring-1 ring-border">
      {src ? (
        <AvatarImage src={src} alt="" className="object-cover" referrerPolicy="no-referrer" />
      ) : null}
      <AvatarFallback
        className="text-2xl font-semibold text-white"
        style={{ backgroundColor: `oklch(0.55 0.13 ${hueFromString(user.id)})` }}
      >
        {initials(user.name, user.username ?? '?')}
      </AvatarFallback>
    </Avatar>
  );
}

function AvatarCard({ user }: { user: MeUser }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const maxUploadMb = useConfig().data?.maxUploadMb;
  const maxBytes = Math.min(AVATAR_MAX_BYTES, (maxUploadMb ?? Infinity) * 1024 * 1024);
  const upload = useUploadAvatar();
  const remove = useRemoveAvatar();
  const [preview, setPreview] = useState<string | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [dragging, setDragging] = useState(false);
  const busy = upload.isPending || remove.isPending;

  useEffect(
    () => () => {
      if (preview) URL.revokeObjectURL(preview);
    },
    [preview],
  );

  function choose(file: File | undefined) {
    if (!file || busy) return;
    if (!ACCEPTED_TYPES.includes(file.type)) {
      toast.error('Use a PNG, JPEG, GIF or WebP image.');
      return;
    }
    if (file.size > maxBytes) {
      toast.error(`That image is larger than ${formatMb(maxBytes)}.`);
      return;
    }
    setPreview(URL.createObjectURL(file));
    setProgress(0);
    upload.mutate(
      { file, onProgress: setProgress },
      {
        onSuccess: () => toast.success('Profile picture updated'),
        onSettled: () => {
          setPreview(null);
          setProgress(null);
        },
      },
    );
  }

  function onDrop(event: DragEvent) {
    event.preventDefault();
    setDragging(false);
    choose(event.dataTransfer.files[0]);
  }

  return (
    <SettingsCard
      title="Profile picture"
      description="Shown next to your name everywhere. Square images look best."
    >
      <div className="flex flex-wrap items-center gap-5">
        <div
          className={cn(
            'relative rounded-full',
            dragging && 'ring-2 ring-primary ring-offset-2 ring-offset-background',
          )}
          onDragOver={(event) => {
            event.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={onDrop}
        >
          <LargeAvatar user={user} src={preview ?? user.image} />
          {progress !== null ? (
            <span
              className="absolute inset-0 flex items-center justify-center rounded-full bg-black/45 text-xs font-medium text-white"
              role="status"
              aria-live="polite"
            >
              {progress < 1 ? `${Math.round(progress * 100)}%` : <Spinner label="Saving" />}
            </span>
          ) : null}
        </div>
        <div className="grid gap-2">
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() => inputRef.current?.click()}
            >
              <ImageUpIcon aria-hidden="true" />
              {user.image ? 'Upload new picture' : 'Upload picture'}
            </Button>
            {user.image ? (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={busy}
                onClick={() =>
                  remove.mutate(undefined, {
                    onSuccess: () => toast.success('Profile picture removed'),
                  })
                }
              >
                {remove.isPending ? <Spinner /> : <Trash2Icon aria-hidden="true" />}
                Remove
              </Button>
            ) : null}
          </div>
          <p className="text-xs text-muted-foreground">
            PNG, JPEG, GIF or WebP, up to {formatMb(maxBytes)}. You can also drop an image on the
            picture.
          </p>
          <input
            ref={inputRef}
            type="file"
            accept={ACCEPTED_TYPES.join(',')}
            className="sr-only"
            tabIndex={-1}
            aria-label="Choose a profile picture"
            onChange={(event) => {
              choose(event.target.files?.[0]);
              event.target.value = '';
            }}
          />
        </div>
      </div>
    </SettingsCard>
  );
}

// ---------------------------------------------------------------------------------------------
// Display name
// ---------------------------------------------------------------------------------------------

function NameCard({ user }: { user: MeUser }) {
  const id = useId();
  const [name, setName] = useState(user.name);
  const [error, setError] = useState<string | null>(null);
  const update = useUpdateProfile({ suppressErrorToast: true });
  const dirty = name.trim() !== user.name;

  function submit(event: FormEvent) {
    event.preventDefault();
    const parsed = displayNameSchema.safeParse(name);
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? 'Invalid name');
      return;
    }
    setError(null);
    update.mutate(
      { name: parsed.data },
      {
        onSuccess: (profile) => {
          setName(profile.name);
          toast.success('Display name saved');
        },
        onError: (cause) => setError(errorMessage(cause)),
      },
    );
  }

  return (
    <form onSubmit={submit} noValidate aria-labelledby={`${id}-title`}>
      <SettingsCard
        title={<span id={`${id}-title`}>Display name</span>}
        description="Your name as teammates see it. It doesn't have to be unique."
        footer={
          <>
            <p className="text-xs text-muted-foreground">
              Up to {LIMITS.displayName.max} characters.
            </p>
            <Button type="submit" size="sm" disabled={!dirty || update.isPending}>
              {update.isPending ? <Spinner /> : null}
              Save
            </Button>
          </>
        }
      >
        <FormField label="Name" error={error} className="max-w-sm">
          {(field) => (
            <Input
              {...field}
              value={name}
              onChange={(event) => {
                setName(event.target.value);
                setError(null);
              }}
              maxLength={LIMITS.displayName.max}
              autoComplete="name"
            />
          )}
        </FormField>
      </SettingsCard>
    </form>
  );
}

// ---------------------------------------------------------------------------------------------
// Username
// ---------------------------------------------------------------------------------------------

function UsernameCard({ user }: { user: MeUser }) {
  const id = useId();
  const current = user.username ?? '';
  const [username, setUsername] = useState(current);
  const [error, setError] = useState<string | null>(null);
  const unchanged = username.trim().toLowerCase() === current;
  // No availability check for the current username (it is "taken" — by you).
  const check = useUsernameAvailability(unchanged ? '' : username);
  const update = useUpdateProfile({ suppressErrorToast: true });

  function submit(event: FormEvent) {
    event.preventDefault();
    const parsed = usernameSchema.safeParse(username);
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? 'Invalid username');
      return;
    }
    if (check.status === 'taken') {
      setError(check.message);
      return;
    }
    setError(null);
    update.mutate(
      { username: parsed.data },
      {
        onSuccess: (profile) => {
          setUsername(profile.username ?? '');
          toast.success(`You are now @${profile.username ?? parsed.data}`);
        },
        onError: (cause) => {
          const field = isApiError(cause) ? cause.fieldErrors.username : undefined;
          setError(field ?? errorMessage(cause));
        },
      },
    );
  }

  return (
    <form onSubmit={submit} noValidate aria-labelledby={`${id}-title`}>
      <SettingsCard
        title={<span id={`${id}-title`}>Username</span>}
        description={
          <>
            Your handle: <span className="font-medium text-foreground">@{current}</span>. It appears
            in mentions and next to your name.
          </>
        }
        footer={
          <>
            <p className="text-xs text-muted-foreground">
              {LIMITS.username.min}–{LIMITS.username.max} lowercase letters, digits or underscores.
            </p>
            <Button
              type="submit"
              size="sm"
              disabled={unchanged || update.isPending || check.status === 'taken'}
            >
              {update.isPending ? <Spinner /> : null}
              Change username
            </Button>
          </>
        }
      >
        <div className="grid max-w-sm gap-4">
          <UsernameField
            value={username}
            onChange={(value) => {
              setUsername(value);
              setError(null);
            }}
            check={check}
            error={error}
          />
        </div>
        {!unchanged ? (
          <div
            role="note"
            className="mt-4 flex gap-2.5 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2.5 text-sm text-amber-900 dark:text-amber-200"
          >
            <TriangleAlertIcon className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
            <p>
              Teammates and agents <AtSignIcon className="inline size-3.5" aria-hidden="true" />
              mention you by username. Existing mentions of{' '}
              <span className="font-medium">@{current}</span> will stop pointing at you, and anyone
              could claim it later.
            </p>
          </div>
        ) : null}
      </SettingsCard>
    </form>
  );
}

// ---------------------------------------------------------------------------------------------

export default function ProfileSettingsPage() {
  const me = useMe();
  return (
    <SettingsPage title="Profile" description="How you appear to your teammates.">
      {me.isPending ? (
        <>
          <SettingsCardSkeleton rows={1} />
          <SettingsCardSkeleton rows={1} />
          <SettingsCardSkeleton rows={1} />
        </>
      ) : me.isError ? (
        <ErrorState error={me.error} onRetry={() => void me.refetch()} />
      ) : (
        <>
          <AvatarCard user={me.data.user} />
          <NameCard key={`name-${me.data.user.name}`} user={me.data.user} />
          <UsernameCard key={`username-${me.data.user.username ?? ''}`} user={me.data.user} />
        </>
      )}
    </SettingsPage>
  );
}
