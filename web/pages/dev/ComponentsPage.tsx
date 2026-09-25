import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { InboxIcon, MonitorIcon, MoonIcon, PlusIcon, SunIcon } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import type { PriorityValue } from '@shared/constants';
import { AttachmentList } from '@web/components/attachments/AttachmentList';
import { AttachmentUploader } from '@web/components/attachments/AttachmentUploader';
import { OtpInput } from '@web/components/auth/OtpInput';
import { PasswordStrengthMeter } from '@web/components/auth/PasswordStrengthMeter';
import { ClaimBadge } from '@web/components/common/ClaimBadge';
import { ConfirmDialog } from '@web/components/common/ConfirmDialog';
import { DueDate } from '@web/components/common/DueDate';
import { EmptyState } from '@web/components/common/EmptyState';
import { EntityIcon } from '@web/components/common/EntityIcon';
import { ErrorState } from '@web/components/common/ErrorState';
import { Kbd } from '@web/components/common/Kbd';
import { LabelChip } from '@web/components/common/LabelChip';
import { NotFound } from '@web/components/common/NotFound';
import { PageHeader } from '@web/components/common/PageHeader';
import { PriorityIcon } from '@web/components/common/PriorityIcon';
import { RelativeTime } from '@web/components/common/RelativeTime';
import { RoleChip } from '@web/components/common/RoleChip';
import { StatusBadge } from '@web/components/common/StatusBadge';
import { TaskKey } from '@web/components/common/TaskKey';
import { AvatarStack, UserAvatar } from '@web/components/common/UserAvatar';
import { UserName } from '@web/components/common/UserName';
import { RichTextEditor } from '@web/components/editor/RichTextEditor';
import { MarkdownView } from '@web/components/markdown/MarkdownView';
import { AssigneePicker, type AssigneeValue } from '@web/components/pickers/AssigneePicker';
import { ColorPicker } from '@web/components/pickers/ColorPicker';
import { DatePicker } from '@web/components/pickers/DatePicker';
import { EmojiPicker } from '@web/components/pickers/EmojiPicker';
import { LabelPicker } from '@web/components/pickers/LabelPicker';
import { PriorityPicker } from '@web/components/pickers/PriorityPicker';
import { StatusPicker } from '@web/components/pickers/StatusPicker';
import { ReplyComposer } from '@web/components/replies/ReplyComposer';
import { Timeline } from '@web/components/replies/Timeline';
import { Button } from '@web/components/ui/button';
import { toDueDate } from '@web/lib/format';
import { queryKeys } from '@web/lib/queryKeys';
import { useTheme } from '@web/lib/theme';
import { useDocumentTitle } from '@web/lib/title';
import * as fixtures from './fixtures';

/** A query client pre-filled with fixtures, so every component renders without a server. */
function createSeededClient(): QueryClient {
  const client = new QueryClient({
    defaultOptions: { queries: { staleTime: Infinity, retry: false, refetchOnWindowFocus: false } },
  });
  client.setQueryData(queryKeys.config(), fixtures.config);
  client.setQueryData(queryKeys.session(), {
    session: { id: 'sess_dev', expiresAt: new Date(Date.now() + 86_400_000) },
    user: {
      id: fixtures.ethan.id,
      email: 'ethan@example.com',
      emailVerified: true,
      name: 'Ethan Ho',
      username: 'ethan',
    },
  });
  client.setQueryData(queryKeys.me(), fixtures.me);
  client.setQueryData(queryKeys.teams.mentionables(fixtures.TEAM_ID, ''), fixtures.mentionables);
  for (const q of ['a', 'ad', 'g', 'd', 'de', 'b']) {
    client.setQueryData(queryKeys.teams.mentionables(fixtures.TEAM_ID, q), {
      users: fixtures.users.filter(
        (user) => user.username.startsWith(q) || user.name.toLowerCase().startsWith(q),
      ),
      roles: fixtures.mentionables.roles.filter((role) => role.slug.startsWith(q)),
    });
  }
  client.setQueryData(queryKeys.replies.list('task', 'task_dev'), { items: fixtures.replies });
  client.setQueryData(queryKeys.activity('task', 'task_dev'), { items: fixtures.activity });
  return client;
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-4" aria-labelledby={`section-${title}`}>
      <h2 id={`section-${title}`} className="border-b pb-2 text-lg font-semibold tracking-tight">
        {title}
      </h2>
      {children}
    </section>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid gap-2 sm:grid-cols-[10rem_1fr] sm:items-center">
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      <div className="flex min-w-0 flex-wrap items-center gap-3">{children}</div>
    </div>
  );
}

function ThemeSwitch() {
  const { theme, setTheme } = useTheme();
  const options = [
    { value: 'light', icon: SunIcon },
    { value: 'dark', icon: MoonIcon },
    { value: 'system', icon: MonitorIcon },
  ] as const;
  return (
    <div className="flex gap-1" role="group" aria-label="Theme">
      {options.map(({ value, icon: Icon }) => (
        <Button
          key={value}
          size="sm"
          variant={theme === value ? 'secondary' : 'ghost'}
          aria-pressed={theme === value}
          onClick={() => setTheme(value)}
        >
          <Icon aria-hidden="true" />
          <span className="capitalize">{value}</span>
        </Button>
      ))}
    </div>
  );
}

const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
const inMinutes = (minutes: number) => new Date(Date.now() + minutes * 60_000).toISOString();
const inDays = (days: number) => toDueDate(new Date(Date.now() + days * 86_400_000));

function Gallery() {
  const [status, setStatus] = useState<string | null>('s_progress');
  const [priority, setPriority] = useState<PriorityValue>(3);
  const [labelIds, setLabelIds] = useState<string[]>(['l_bug']);
  const [labelOptions, setLabelOptions] = useState(fixtures.labels);
  const [assignees, setAssignees] = useState<AssigneeValue>({
    userIds: ['u_ada'],
    roleIds: ['r_backend'],
  });
  const [dueDate, setDueDate] = useState<string | null>(inDays(3));
  const [color, setColor] = useState('#6366f1');
  const [emoji, setEmoji] = useState<string | null>('🚀');
  const [markdown, setMarkdown] = useState(
    'Hello @ada! Type **/** for blocks.\n\n- [ ] try a to-do',
  );
  const [compact, setCompact] = useState('');
  const [confirmOpen, setConfirmOpen] = useState(false);

  return (
    <div className="mx-auto w-full max-w-5xl space-y-10 px-4 py-8 sm:px-6">
      <PageHeader
        title="Component gallery"
        description="Development only: every shared component with sample data."
        actions={<ThemeSwitch />}
      />

      <Section title="People">
        <Row label="UserAvatar">
          {(['xs', 'sm', 'md', 'lg', 'xl'] as const).map((size) => (
            <UserAvatar key={size} user={fixtures.ada} size={size} />
          ))}
          <UserAvatar user={null} size="lg" />
        </Row>
        <Row label="AvatarStack">
          <AvatarStack users={fixtures.users} max={3} />
          <AvatarStack users={fixtures.users.slice(0, 2)} size="lg" />
        </Row>
        <Row label="UserName">
          <UserName user={fixtures.ada} avatar="md" />
          <UserName user={fixtures.ethan} via={{ keyId: 'k', keyName: 'Claude on laptop' }} />
          <UserName user={fixtures.grace} color="#ec4899" />
          <UserName user={null} />
          <UserName user={null} source="system" />
        </Row>
        <Row label="RoleChip">
          {fixtures.roles.map((role) => (
            <RoleChip key={role.id} role={role} mention />
          ))}
        </Row>
      </Section>

      <Section title="Work items">
        <Row label="LabelChip">
          {fixtures.labels.map((label) => (
            <LabelChip key={label.id} label={label} />
          ))}
        </Row>
        <Row label="StatusBadge">
          {fixtures.statuses.map((item) => (
            <StatusBadge key={item.id} status={item} />
          ))}
          <StatusBadge status={fixtures.statuses[3]!} iconOnly />
        </Row>
        <Row label="PriorityIcon">
          {([0, 1, 2, 3, 4] as const).map((value) => (
            <PriorityIcon key={value} value={value} showLabel />
          ))}
        </Row>
        <Row label="TaskKey">
          <TaskKey projectKey="WEB" number={12} to="/t/acme/p/WEB/tasks/12" />
          <TaskKey projectKey="API" number={51} kind="issue" />
        </Row>
        <Row label="DueDate">
          <DueDate value={inDays(-2)} />
          <DueDate value={inDays(0)} />
          <DueDate value={inDays(1)} />
          <DueDate value={inDays(40)} />
          <DueDate value={inDays(-2)} done />
        </Row>
        <Row label="ClaimBadge">
          <ClaimBadge
            holder={fixtures.ethan}
            via={{ keyId: 'k', keyName: 'Claude on laptop' }}
            claimedAt={minutesAgo(4)}
            expiresAt={inMinutes(26)}
          />
          <ClaimBadge
            holder={fixtures.ada}
            via={null}
            claimedAt={minutesAgo(90)}
            expiresAt={inMinutes(30)}
          />
          <ClaimBadge
            holder={fixtures.grace}
            via={{ keyId: 'k2', keyName: 'Codex desktop' }}
            claimedAt={minutesAgo(50)}
            expiresAt={minutesAgo(20)}
          />
        </Row>
        <Row label="EntityIcon">
          <EntityIcon icon="🚀" name="Acme" color="#6366f1" />
          <EntityIcon icon={null} name="Web app" color="#0ea5e9" />
        </Row>
        <Row label="Kbd">
          <Kbd keys="mod+k" />
          <Kbd keys="g d" />
          <Kbd keys="?" />
          <Kbd keys="shift+enter" />
        </Row>
        <Row label="RelativeTime">
          <RelativeTime value={minutesAgo(0)} />
          <RelativeTime value={minutesAgo(4)} />
          <RelativeTime value={minutesAgo(300)} />
          <RelativeTime value={minutesAgo(60 * 24 * 40)} />
        </Row>
      </Section>

      <Section title="Pickers">
        <Row label="Status / priority">
          <StatusPicker statuses={fixtures.statuses} value={status} onChange={setStatus} />
          <PriorityPicker value={priority} onChange={setPriority} />
        </Row>
        <Row label="Labels / assignees">
          <LabelPicker
            labels={labelOptions}
            value={labelIds}
            onChange={setLabelIds}
            onCreate={(name) => {
              const label = { id: `l_${name}`, name, color: '#6b7280', description: null };
              setLabelOptions((current) => [...current, label]);
              return label;
            }}
          />
          <AssigneePicker
            users={fixtures.users}
            roles={fixtures.roles.slice(1)}
            value={assignees}
            onChange={setAssignees}
            currentUserId={fixtures.ethan.id}
          />
        </Row>
        <Row label="Date / color / emoji">
          <DatePicker value={dueDate} onChange={setDueDate} />
          <ColorPicker value={color} onChange={setColor} />
          <EmojiPicker value={emoji} onChange={setEmoji} />
        </Row>
      </Section>

      <Section title="Editor">
        <RichTextEditor
          value={markdown}
          onChange={setMarkdown}
          teamId={fixtures.TEAM_ID}
          label="Description"
        />
        <pre className="overflow-x-auto rounded-md border bg-muted/50 p-3 font-mono text-xs whitespace-pre-wrap">
          {markdown}
        </pre>
        <RichTextEditor
          value={compact}
          onChange={setCompact}
          variant="compact"
          placeholder="Compact variant…"
          teamId={fixtures.TEAM_ID}
          label="Compact editor"
        />
      </Section>

      <Section title="Markdown">
        <div className="rounded-lg border p-4">
          <MarkdownView markdown={fixtures.sampleMarkdown} teamId={fixtures.TEAM_ID} />
        </div>
      </Section>

      <Section title="Attachments">
        <AttachmentList
          attachments={fixtures.attachments}
          canDelete={() => true}
          onDelete={() => undefined}
        />
        <AttachmentUploader
          teamId={fixtures.TEAM_ID}
          variant="dropzone"
          onUploaded={() => undefined}
        />
      </Section>

      <Section title="Replies & history">
        <Timeline parentType="task" parentId="task_dev" />
        <ReplyComposer parentType="task" parentId="task_dev" teamId={fixtures.TEAM_ID} />
      </Section>

      <Section title="Auth">
        <Row label="OtpInput">
          <OtpInput />
        </Row>
        <Row label="Password strength">
          <div className="grid w-64 gap-3">
            <PasswordStrengthMeter password="short" />
            <PasswordStrengthMeter password="password123" />
            <PasswordStrengthMeter password="Tr0ub4dor&3xyz!" />
          </div>
        </Row>
      </Section>

      <Section title="States">
        <EmptyState
          icon={InboxIcon}
          title="You’re all caught up"
          description="New mentions and assignments show up here."
          action={
            <Button size="sm">
              <PlusIcon aria-hidden="true" />
              Create a team
            </Button>
          }
        />
        <ErrorState
          error={new Error('The server had a problem (502). Try again.')}
          onRetry={() => undefined}
        />
        <div className="rounded-lg border">
          <NotFound what="Task" />
        </div>
        <Row label="ConfirmDialog">
          <Button variant="destructive" onClick={() => setConfirmOpen(true)}>
            Delete team…
          </Button>
          <ConfirmDialog
            open={confirmOpen}
            onOpenChange={setConfirmOpen}
            title="Delete Acme?"
            description="The team and all its projects move to Trash for 30 days."
            confirmLabel="Delete team"
            destructive
            typedConfirmation="acme"
            onConfirm={() => undefined}
          />
        </Row>
      </Section>
    </div>
  );
}

export default function ComponentsPage() {
  useDocumentTitle(['Component gallery']);
  const [client] = useState(createSeededClient);
  return (
    <QueryClientProvider client={client}>
      <Gallery />
    </QueryClientProvider>
  );
}
