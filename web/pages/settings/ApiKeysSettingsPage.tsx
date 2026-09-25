import { KeyRoundIcon, PlusIcon, TriangleAlertIcon } from 'lucide-react';
import { useId, useState, type FormEvent } from 'react';
import { useSearchParams } from 'react-router';
import { toast } from 'sonner';
import { LIMITS } from '@shared/constants';
import {
  createApiKeyInputSchema,
  type ApiKey,
  type CreateApiKeyResponse,
} from '@shared/schemas/core';
import { FormError, FormField } from '@web/components/auth/FormField';
import { ConfirmDialog } from '@web/components/common/ConfirmDialog';
import { EmptyState } from '@web/components/common/EmptyState';
import { ErrorState } from '@web/components/common/ErrorState';
import { RelativeTime } from '@web/components/common/RelativeTime';
import { Spinner } from '@web/components/common/Spinner';
import { Badge } from '@web/components/ui/badge';
import { Button } from '@web/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@web/components/ui/dialog';
import { Input } from '@web/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@web/components/ui/select';
import { Skeleton } from '@web/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@web/components/ui/tabs';
import { errorMessage, isApiError } from '@web/lib/api';
import { formatDateTime, formatShortDate } from '@web/lib/format';
import { useHotkey } from '@web/lib/hotkeys';
import { cn } from '@web/lib/utils';
import { claudeCodeCommand, codexConfig, codexExport, curlExample } from './agentSetup';
import { CodeBlock, CopyButton } from './CopyButton';
import { useApiKeys, useCreateApiKey, useRevokeApiKey } from './queries';
import { SettingsCard, SettingsPage } from './SettingsCard';

const EXPIRY_OPTIONS = [
  { value: 'never', label: 'Never', days: undefined },
  { value: '30', label: '30 days', days: 30 },
  { value: '90', label: '90 days', days: 90 },
  { value: '365', label: '1 year', days: 365 },
] as const;

type ExpiryValue = (typeof EXPIRY_OPTIONS)[number]['value'];

type KeyState = 'active' | 'expired' | 'revoked';

function keyState(key: ApiKey, now = Date.now()): KeyState {
  if (key.revokedAt) return 'revoked';
  if (key.expiresAt && new Date(key.expiresAt).getTime() <= now) return 'expired';
  return 'active';
}

function origin(): string {
  return window.location.origin;
}

// ---------------------------------------------------------------------------------------------
// Setup snippets
// ---------------------------------------------------------------------------------------------

/** Ready-to-paste setup for Claude Code, Codex and scripts, for `key` (or a placeholder). */
function AgentSetup({ apiKey }: { apiKey: string }) {
  return (
    <Tabs defaultValue="claude" className="min-w-0 gap-3">
      <TabsList>
        <TabsTrigger value="claude">Claude Code</TabsTrigger>
        <TabsTrigger value="codex">Codex</TabsTrigger>
        <TabsTrigger value="rest">REST API</TabsTrigger>
      </TabsList>
      <TabsContent value="claude" className="grid min-w-0 gap-2">
        <p className="text-sm text-muted-foreground">Run this in a terminal:</p>
        <CodeBlock code={claudeCodeCommand(origin(), apiKey)} label="Copy Claude Code command" />
      </TabsContent>
      <TabsContent value="codex" className="grid min-w-0 gap-2">
        <p className="text-sm text-muted-foreground">
          Add the server to <code className="font-mono text-xs">~/.codex/config.toml</code>:
        </p>
        <CodeBlock code={codexConfig(origin())} label="Copy Codex configuration" />
        <p className="text-sm text-muted-foreground">
          Then provide the key in your shell profile (for example{' '}
          <code className="font-mono text-xs">~/.zshrc</code>):
        </p>
        <CodeBlock code={codexExport(apiKey)} label="Copy export line" />
      </TabsContent>
      <TabsContent value="rest" className="grid min-w-0 gap-2">
        <p className="text-sm text-muted-foreground">
          Scripts can call the REST API with the same key:
        </p>
        <CodeBlock code={curlExample(origin(), apiKey)} label="Copy curl example" />
      </TabsContent>
    </Tabs>
  );
}

// ---------------------------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------------------------

function CreatedKey({ created }: { created: CreateApiKeyResponse }) {
  return (
    <div className="grid min-w-0 gap-4">
      <div
        role="note"
        className="flex gap-2.5 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2.5 text-sm text-amber-900 dark:text-amber-200"
      >
        <TriangleAlertIcon className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
        <p>Copy the key now. For your security it won’t be shown again.</p>
      </div>
      <div className="flex min-w-0 items-center gap-2">
        <code
          className="min-w-0 flex-1 truncate rounded-md border bg-muted/50 px-3 py-2 font-mono text-sm select-all"
          aria-label="Your new API key"
        >
          {created.key}
        </code>
        <CopyButton value={created.key} label="Copy key" showLabel />
      </div>
      <div className="grid min-w-0 gap-2">
        <h3 className="text-sm font-semibold">Connect an agent</h3>
        <AgentSetup apiKey={created.key} />
      </div>
    </div>
  );
}

function CreateKeyDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const id = useId();
  const [name, setName] = useState('');
  const [expiry, setExpiry] = useState<ExpiryValue>('never');
  const [nameError, setNameError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [created, setCreated] = useState<CreateApiKeyResponse | null>(null);
  const create = useCreateApiKey();

  function submit(event: FormEvent) {
    event.preventDefault();
    const days = EXPIRY_OPTIONS.find((option) => option.value === expiry)?.days;
    const parsed = createApiKeyInputSchema.safeParse({ name, expiresInDays: days });
    if (!parsed.success) {
      setNameError(parsed.error.issues[0]?.message ?? 'Invalid name');
      return;
    }
    setNameError(null);
    setFormError(null);
    create.mutate(parsed.data, {
      onSuccess: (result) => {
        setCreated(result);
        toast.success(`API key “${result.apiKey.name}” created`);
      },
      onError: (cause) => {
        const field = isApiError(cause) ? cause.fieldErrors.name : undefined;
        if (field) setNameError(field);
        else setFormError(errorMessage(cause));
      },
    });
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !create.isPending && onOpenChange(next)}>
      <DialogContent
        className={cn(created && 'sm:max-w-2xl')}
        // Losing the key by a stray click outside would be painful: close explicitly.
        onInteractOutside={(event) => {
          if (created) event.preventDefault();
        }}
      >
        {created ? (
          <>
            <DialogHeader>
              <DialogTitle>Your new API key</DialogTitle>
              <DialogDescription>
                “{created.apiKey.name}” acts as you. Anything an agent does with it shows as you via{' '}
                {created.apiKey.name}.
              </DialogDescription>
            </DialogHeader>
            <CreatedKey created={created} />
            <DialogFooter>
              <Button type="button" onClick={() => onOpenChange(false)}>
                Done
              </Button>
            </DialogFooter>
          </>
        ) : (
          <form className="grid gap-4" onSubmit={submit} noValidate>
            <DialogHeader>
              <DialogTitle>New API key</DialogTitle>
              <DialogDescription>
                For an agent (Claude Code, Codex) or a script. It can do anything you can, except
                manage your password, sessions and keys.
              </DialogDescription>
            </DialogHeader>
            <FormField
              label="Name"
              error={nameError}
              hint="Where it's used, e.g. “Claude on laptop”. Shown next to everything it does."
            >
              {(field) => (
                <Input
                  {...field}
                  value={name}
                  onChange={(event) => {
                    setName(event.target.value);
                    setNameError(null);
                  }}
                  maxLength={LIMITS.apiKeyName.max}
                  placeholder="Claude on laptop"
                  autoComplete="off"
                  autoFocus
                />
              )}
            </FormField>
            <div className="grid gap-1.5">
              <label id={`${id}-expiry`} className="text-sm font-medium">
                Expires
              </label>
              <Select value={expiry} onValueChange={(value) => setExpiry(value as ExpiryValue)}>
                <SelectTrigger aria-labelledby={`${id}-expiry`} className="w-full sm:w-48">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {EXPIRY_OPTIONS.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <FormError message={formError} />
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                disabled={create.isPending}
                onClick={() => onOpenChange(false)}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={create.isPending}>
                {create.isPending ? <Spinner /> : null}
                Create key
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------------------------

const STATE_BADGE: Record<KeyState, { label: string; className: string }> = {
  active: {
    label: 'Active',
    className: 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300',
  },
  expired: { label: 'Expired', className: 'bg-amber-500/10 text-amber-700 dark:text-amber-300' },
  revoked: { label: 'Revoked', className: 'bg-muted text-muted-foreground' },
};

function KeyRow({ apiKey, onRevoke }: { apiKey: ApiKey; onRevoke: (key: ApiKey) => void }) {
  const state = keyState(apiKey);
  const badge = STATE_BADGE[state];
  return (
    <li
      className={cn(
        'flex flex-wrap items-center gap-x-4 gap-y-2 py-3 first:pt-0 last:pb-0',
        state !== 'active' && 'opacity-70',
      )}
    >
      <span className="flex size-9 shrink-0 items-center justify-center rounded-md border bg-background text-muted-foreground">
        <KeyRoundIcon className="size-4" aria-hidden="true" />
      </span>
      <div className="min-w-0 flex-1 basis-56">
        <p className="flex flex-wrap items-center gap-2">
          <span className="truncate text-sm font-medium">{apiKey.name}</span>
          <Badge className={cn('font-normal', badge.className)}>{badge.label}</Badge>
        </p>
        <p className="mt-0.5 flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
          <code className="font-mono">bat_{apiKey.prefix}…</code>
          <span>
            Created{' '}
            <time dateTime={apiKey.createdAt} title={formatDateTime(apiKey.createdAt)}>
              {formatShortDate(apiKey.createdAt)}
            </time>
          </span>
          <span>
            {apiKey.lastUsedAt ? (
              <>
                Last used <RelativeTime value={apiKey.lastUsedAt} />
              </>
            ) : (
              'Never used'
            )}
          </span>
          <span>
            {apiKey.revokedAt ? (
              <>
                Revoked <RelativeTime value={apiKey.revokedAt} />
              </>
            ) : apiKey.expiresAt ? (
              <>
                {state === 'expired' ? 'Expired' : 'Expires'}{' '}
                <time dateTime={apiKey.expiresAt} title={formatDateTime(apiKey.expiresAt)}>
                  {formatShortDate(apiKey.expiresAt)}
                </time>
              </>
            ) : (
              'No expiry'
            )}
          </span>
        </p>
      </div>
      {state === 'revoked' ? null : (
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="text-destructive hover:text-destructive"
          onClick={() => onRevoke(apiKey)}
          aria-label={`Revoke ${apiKey.name}`}
        >
          Revoke
        </Button>
      )}
    </li>
  );
}

function KeyListSkeleton() {
  return (
    <div className="grid gap-4" aria-hidden="true">
      {[0, 1, 2].map((row) => (
        <div key={row} className="flex items-center gap-4">
          <Skeleton className="size-9 rounded-md" />
          <div className="grid flex-1 gap-2">
            <Skeleton className="h-4 w-40" />
            <Skeleton className="h-3 w-72 max-w-full" />
          </div>
        </div>
      ))}
    </div>
  );
}

export default function ApiKeysSettingsPage() {
  const keys = useApiKeys();
  const revoke = useRevokeApiKey();
  const [params, setParams] = useSearchParams();
  const [open, setOpen] = useState(false);
  const [revoking, setRevoking] = useState<ApiKey | null>(null);
  // `?new=1` (the palette's "Create an API key") opens the dialog too.
  const creating = open || params.get('new') === '1';

  function openCreate() {
    setOpen(true);
  }

  function closeCreate(next: boolean) {
    setOpen(next);
    if (!next && params.has('new')) setParams({}, { replace: true });
  }

  useHotkey('c', openCreate, { description: 'Create an API key', group: 'Settings' });

  const sorted = [...(keys.data?.apiKeys ?? [])].sort(
    (a, b) => Number(keyState(a) !== 'active') - Number(keyState(b) !== 'active'),
  );
  const activeCount = sorted.filter((key) => keyState(key) === 'active').length;

  return (
    <SettingsPage
      title="API keys"
      description="Keys let agents like Claude Code and Codex, and your scripts, act as you over MCP and the REST API."
      actions={
        <Button type="button" size="sm" onClick={openCreate}>
          <PlusIcon aria-hidden="true" />
          New API key
        </Button>
      }
    >
      <SettingsCard
        title="Your keys"
        description={
          keys.data
            ? `${activeCount} active of at most ${LIMITS.apiKeysPerUser}. Revoked and expired keys stop working at once.`
            : undefined
        }
      >
        {keys.isPending ? (
          <KeyListSkeleton />
        ) : keys.isError ? (
          <ErrorState error={keys.error} onRetry={() => void keys.refetch()} />
        ) : sorted.length === 0 ? (
          <EmptyState
            icon={KeyRoundIcon}
            title="No API keys yet"
            description="Create a key to connect Claude Code, Codex or a script to Baton."
            action={
              <Button type="button" size="sm" onClick={openCreate}>
                <PlusIcon aria-hidden="true" />
                Create API key
              </Button>
            }
          />
        ) : (
          <ul className="divide-y" aria-label="API keys">
            {sorted.map((apiKey) => (
              <KeyRow key={apiKey.id} apiKey={apiKey} onRevoke={setRevoking} />
            ))}
          </ul>
        )}
      </SettingsCard>

      <SettingsCard
        title="Connect an agent"
        description="Create a key, then paste one of these. Replace bat_… with your key; the dialog after creating one fills it in for you."
      >
        <AgentSetup apiKey="bat_…" />
      </SettingsCard>

      {creating ? <CreateKeyDialog open onOpenChange={closeCreate} /> : null}
      <ConfirmDialog
        open={revoking !== null}
        onOpenChange={(open) => !open && setRevoking(null)}
        title={`Revoke “${revoking?.name ?? ''}”?`}
        description="Agents and scripts using this key lose access immediately. This can’t be undone."
        confirmLabel="Revoke key"
        destructive
        onConfirm={async () => {
          if (!revoking) return;
          await revoke.mutateAsync(revoking.id);
          toast.success(`“${revoking.name}” revoked`);
        }}
      />
    </SettingsPage>
  );
}
