import { CheckIcon, CopyIcon, LinkIcon } from 'lucide-react';
import { useId, useState } from 'react';
import {
  INVITE_EXPIRY_LABELS,
  INVITE_EXPIRY_OPTIONS,
  INVITE_MAX_USES_OPTIONS,
  type Invite,
  type InviteExpiry,
} from '@shared/schemas/teams';
import { FormError } from '@web/components/auth/FormField';
import { Spinner } from '@web/components/common/Spinner';
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
import { Label } from '@web/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@web/components/ui/select';
import { errorMessage } from '@web/lib/api';
import { useCreateInvite } from './api';
import { copyText, inviteLink } from './clipboard';

const maxUsesLabel = (value: number | null) =>
  value === null ? 'No limit' : value === 1 ? '1 use' : `${value} uses`;

export interface InviteDialogProps {
  teamId: string;
  teamName: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/** "Invite people": pick expiry and max uses, create the link, then copy it. */
export function InviteDialog({ teamId, teamName, open, onOpenChange }: InviteDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        {open ? (
          <InviteDialogBody
            teamId={teamId}
            teamName={teamName}
            onClose={() => onOpenChange(false)}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function InviteDialogBody({
  teamId,
  teamName,
  onClose,
}: {
  teamId: string;
  teamName: string;
  onClose: () => void;
}) {
  const expiryId = useId();
  const usesId = useId();
  const linkId = useId();
  const createInvite = useCreateInvite(teamId);
  const [expiresIn, setExpiresIn] = useState<InviteExpiry>('7d');
  const [maxUses, setMaxUses] = useState<number | null>(null);
  const [created, setCreated] = useState<Invite | null>(null);
  const [copied, setCopied] = useState(false);

  if (created) {
    const link = inviteLink(created);
    return (
      <div className="grid gap-5">
        <DialogHeader>
          <DialogTitle>Invite link ready</DialogTitle>
          <DialogDescription>
            Anyone with a Baton account can join {teamName} with this link
            {created.expiresAt ? ` for the next ${INVITE_EXPIRY_LABELS[expiresIn]}` : ''}
            {created.maxUses ? ` (${maxUsesLabel(created.maxUses)})` : ''}.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-1.5">
          <Label htmlFor={linkId}>Invite link</Label>
          <div className="flex gap-2">
            <Input
              id={linkId}
              readOnly
              value={link}
              className="font-mono text-xs"
              onFocus={(event) => event.currentTarget.select()}
            />
            <Button
              type="button"
              onClick={() =>
                void copyText(link).then((ok) => {
                  if (ok) setCopied(true);
                })
              }
            >
              {copied ? <CheckIcon aria-hidden="true" /> : <CopyIcon aria-hidden="true" />}
              {copied ? 'Copied' : 'Copy'}
            </Button>
          </div>
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => setCreated(null)}>
            New link
          </Button>
          <Button type="button" onClick={onClose}>
            Done
          </Button>
        </DialogFooter>
      </div>
    );
  }

  return (
    <form
      className="grid gap-5"
      onSubmit={(event) => {
        event.preventDefault();
        createInvite.mutate({ expiresIn, maxUses }, { onSuccess: setCreated });
      }}
    >
      <DialogHeader>
        <DialogTitle>Invite people to {teamName}</DialogTitle>
        <DialogDescription>
          Create a link to share. Anyone who opens it while it’s valid can join the team.
        </DialogDescription>
      </DialogHeader>
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="grid gap-1.5">
          <Label htmlFor={expiryId}>Expire after</Label>
          <Select value={expiresIn} onValueChange={(value) => setExpiresIn(value as InviteExpiry)}>
            <SelectTrigger id={expiryId} className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {INVITE_EXPIRY_OPTIONS.map((option) => (
                <SelectItem key={option} value={option}>
                  {INVITE_EXPIRY_LABELS[option]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor={usesId}>Max number of uses</Label>
          <Select
            value={maxUses === null ? 'none' : String(maxUses)}
            onValueChange={(value) => setMaxUses(value === 'none' ? null : Number(value))}
          >
            <SelectTrigger id={usesId} className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {INVITE_MAX_USES_OPTIONS.map((option) => (
                <SelectItem
                  key={option ?? 'none'}
                  value={option === null ? 'none' : String(option)}
                >
                  {maxUsesLabel(option)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>
      <FormError message={createInvite.isError ? errorMessage(createInvite.error) : null} />
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onClose} disabled={createInvite.isPending}>
          Cancel
        </Button>
        <Button type="submit" disabled={createInvite.isPending}>
          {createInvite.isPending ? <Spinner /> : <LinkIcon aria-hidden="true" />}
          Create link
        </Button>
      </DialogFooter>
    </form>
  );
}
