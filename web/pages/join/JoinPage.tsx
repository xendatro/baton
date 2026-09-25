import { BanIcon, CheckCircle2Icon, ClockIcon, LinkIcon, UsersIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { toast } from 'sonner';
import {
  INVITE_ERROR_REASONS,
  inviteCodeSchema,
  type InviteErrorReason,
  type InvitePreview,
} from '@shared/schemas/teams';
import { ErrorState } from '@web/components/common/ErrorState';
import { PageContainer } from '@web/components/common/PageContainer';
import { Spinner } from '@web/components/common/Spinner';
import { UserName } from '@web/components/common/UserName';
import { Button } from '@web/components/ui/button';
import { Skeleton } from '@web/components/ui/skeleton';
import { isApiError } from '@web/lib/api';
import { formatDateTime, pluralize } from '@web/lib/format';
import { useDocumentTitle } from '@web/lib/title';
import { useAcceptInvite, useInvitePreview } from '@web/pages/teams/api';
import { TeamIcon } from '@web/pages/teams/TeamIcon';

/** `/join/:code`: who invited you to which team, and a Join button. */
export default function JoinPage() {
  const { code = '' } = useParams();
  const valid = inviteCodeSchema.safeParse(code).success;
  useDocumentTitle(['Join a team']);
  return (
    <PageContainer width="narrow" className="flex min-h-[70vh] items-center justify-center">
      <div className="w-full max-w-md">
        {valid ? <Invitation code={code} /> : <Unusable reason="invalid" />}
      </div>
    </PageContainer>
  );
}

function errorReason(error: unknown): InviteErrorReason | null {
  if (!isApiError(error) || error.code !== 'not_found') return null;
  const details = error.details;
  const reason =
    typeof details === 'object' && details !== null && 'reason' in details
      ? details.reason
      : 'invalid';
  return INVITE_ERROR_REASONS.find((candidate) => candidate === reason) ?? 'invalid';
}

function Invitation({ code }: { code: string }) {
  const preview = useInvitePreview(code);
  if (preview.isPending) return <PreviewSkeleton />;
  if (preview.isError) {
    const reason = errorReason(preview.error);
    if (reason) return <Unusable reason={reason} />;
    return (
      <ErrorState
        title="Couldn’t open this invite"
        error={preview.error}
        onRetry={() => void preview.refetch()}
      />
    );
  }
  return <InviteCard code={code} preview={preview.data} />;
}

function Card({ children }: { children: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-5 rounded-xl border bg-card px-6 py-8 text-center shadow-sm sm:px-8">
      {children}
    </div>
  );
}

function InviteCard({ code, preview }: { code: string; preview: InvitePreview }) {
  const navigate = useNavigate();
  const accept = useAcceptInvite(code);
  const { team } = preview;
  const teamPath = `/t/${team.slug}`;

  return (
    <Card>
      <TeamIcon icon={team.icon} name={team.name} color={team.color} size="xl" />
      <div className="space-y-1.5">
        {preview.alreadyMember ? (
          <p className="text-sm text-muted-foreground">You’re already a member of</p>
        ) : preview.inviter ? (
          <p className="flex flex-wrap items-center justify-center gap-1 text-sm text-muted-foreground">
            <UserName user={preview.inviter} avatar="sm" hovercard={false} /> invited you to join
          </p>
        ) : (
          <p className="text-sm text-muted-foreground">You’ve been invited to join</p>
        )}
        <h1 className="text-2xl font-semibold tracking-tight break-words">{team.name}</h1>
        {team.description ? (
          <p className="line-clamp-3 text-sm text-muted-foreground">{team.description}</p>
        ) : null}
      </div>
      <div className="flex flex-wrap items-center justify-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
        <span className="inline-flex items-center gap-1">
          <UsersIcon className="size-3.5" aria-hidden="true" />
          {pluralize(team.memberCount, 'member')}
        </span>
        {!preview.alreadyMember && preview.expiresAt ? (
          <span className="inline-flex items-center gap-1">
            <ClockIcon className="size-3.5" aria-hidden="true" />
            Link expires {formatDateTime(preview.expiresAt)}
          </span>
        ) : null}
      </div>
      {preview.alreadyMember ? (
        <Button asChild className="w-full sm:w-auto">
          <Link to={teamPath}>
            <CheckCircle2Icon aria-hidden="true" />
            Open {team.name}
          </Link>
        </Button>
      ) : (
        <div className="flex w-full flex-col gap-2 sm:w-auto sm:flex-row-reverse">
          <Button
            onClick={() =>
              accept.mutate(undefined, {
                onSuccess: (result) => {
                  toast.success(
                    result.alreadyMember
                      ? `You’re already in ${result.team.name}`
                      : `Welcome to ${result.team.name}!`,
                  );
                  void navigate(`/t/${result.team.slug}`);
                },
              })
            }
            disabled={accept.isPending}
          >
            {accept.isPending ? <Spinner /> : null}
            Join {team.name}
          </Button>
          <Button variant="ghost" asChild>
            <Link to="/">Not now</Link>
          </Button>
        </div>
      )}
    </Card>
  );
}

const UNUSABLE: Record<
  InviteErrorReason,
  { title: string; description: string; icon: typeof BanIcon }
> = {
  invalid: {
    title: 'This invite isn’t valid',
    description:
      'The link may be mistyped, or its team no longer exists. Ask whoever sent it for a new one.',
    icon: LinkIcon,
  },
  expired: {
    title: 'This invite has expired',
    description: 'Invite links can expire. Ask a member of the team for a fresh link.',
    icon: ClockIcon,
  },
  revoked: {
    title: 'This invite was revoked',
    description: 'Someone on the team turned this link off. Ask them for a new one.',
    icon: BanIcon,
  },
  used_up: {
    title: 'This invite has been used up',
    description:
      'The link reached its maximum number of uses. Ask a member of the team for another.',
    icon: UsersIcon,
  },
};

function Unusable({ reason }: { reason: InviteErrorReason }) {
  const { title, description, icon: Icon } = UNUSABLE[reason];
  return (
    <Card>
      <span className="flex size-12 items-center justify-center rounded-full bg-muted text-muted-foreground">
        <Icon className="size-6" aria-hidden="true" />
      </span>
      <div className="space-y-1.5">
        <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
        <p className="text-sm text-muted-foreground">{description}</p>
      </div>
      <Button variant="outline" asChild>
        <Link to="/">Back to dashboard</Link>
      </Button>
    </Card>
  );
}

function PreviewSkeleton() {
  return (
    <Card>
      <div role="status" aria-label="Loading invite" className="flex flex-col items-center gap-4">
        <Skeleton className="size-16 rounded-2xl" />
        <Skeleton className="h-4 w-40" />
        <Skeleton className="h-7 w-52" />
        <Skeleton className="h-9 w-32" />
      </div>
    </Card>
  );
}
