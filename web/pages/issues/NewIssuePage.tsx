import { LockIcon } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { toast } from 'sonner';
import type { Attachment, MeProject, MeTeam } from '@shared/schemas/core';
import { titleSchema } from '@shared/schemas/common';
import type { Issue } from '@shared/schemas/issues';
import { AttachmentList } from '@web/components/attachments/AttachmentList';
import { AttachmentUploader } from '@web/components/attachments/AttachmentUploader';
import { FormField } from '@web/components/auth/FormField';
import { EmptyState } from '@web/components/common/EmptyState';
import { Kbd } from '@web/components/common/Kbd';
import { BackLink } from '@web/components/common/BackLink';
import { PageContainer } from '@web/components/common/PageContainer';
import { Spinner } from '@web/components/common/Spinner';
import { RichTextEditor } from '@web/components/editor/RichTextEditor';
import { LabelPicker } from '@web/components/pickers/LabelPicker';
import { Button } from '@web/components/ui/button';
import { Input } from '@web/components/ui/input';
import { errorMessage, isApiError } from '@web/lib/api';
import { useHotkey } from '@web/lib/hotkeys';
import { useProjectAccess } from '@web/lib/permissions';
import { useRouteContext } from '@web/lib/routeContext';
import { useDocumentTitle } from '@web/lib/title';
import { useLabels } from '@web/pages/projects/queries';
import { UnsavedChangesGuard } from '@web/pages/projects/UnsavedChangesGuard';
import { useCreateLabelOption } from './labels';
import { useCreateIssue } from './queries';

/**
 * New issue (`/t/:team/p/:key/issues/new`): title, a rich markdown body with mentions and
 * uploads, labels (created on the fly with `MANAGE_LABELS`) and attachments. Ctrl/Cmd+Enter
 * submits from anywhere in the form.
 */
export default function NewIssuePage() {
  const { team, project } = useRouteContext();
  if (!team || !project) return null;
  return <NewIssueForm key={project.id} team={team} project={project} />;
}

function NewIssueForm({ team, project }: { team: MeTeam; project: MeProject }) {
  useDocumentTitle(['New issue', project.name]);
  const navigate = useNavigate();
  const access = useProjectAccess(team.id, project.id);
  const base = `/t/${team.slug}/p/${project.key}`;
  const labels = useLabels(project.id);
  const createLabel = useCreateLabelOption(project.id, access.has('MANAGE_LABELS'));
  const create = useCreateIssue(project.id);

  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [labelIds, setLabelIds] = useState<string[]>([]);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [titleError, setTitleError] = useState<string | null>(null);
  const [created, setCreated] = useState<Issue | null>(null);
  const titleRef = useRef<HTMLInputElement>(null);
  /** Guards against a second submit before the pending state renders (Enter + Ctrl+Enter). */
  const submitting = useRef(false);
  const dirty =
    title.trim() !== '' || body.trim() !== '' || labelIds.length > 0 || attachments.length > 0;

  // Leave once the guard has re-rendered without the unsaved-changes block.
  useEffect(() => {
    if (created) void navigate(`${base}/issues/${created.number}`);
  }, [created, base, navigate]);

  const submit = () => {
    if (submitting.current || created) return;
    const parsed = titleSchema.safeParse(title);
    if (!parsed.success) {
      setTitleError(parsed.error.issues[0]?.message ?? 'Required');
      titleRef.current?.focus();
      return;
    }
    submitting.current = true;
    create.mutate(
      {
        title: parsed.data,
        body: body.trim(),
        labelIds: labelIds.length > 0 ? labelIds : undefined,
        attachmentIds: attachments.length > 0 ? attachments.map((file) => file.id) : undefined,
      },
      {
        onSuccess: (issue) => {
          toast.success(`Issue ${issue.ref} opened`);
          setCreated(issue);
        },
        onError: (error) => {
          submitting.current = false;
          const fields = isApiError(error) ? error.fieldErrors : {};
          if (fields.title) setTitleError(fields.title);
        },
      },
    );
  };

  useHotkey('mod+enter', submit, {
    description: 'Create the issue',
    group: 'Issues',
    allowInInputs: true,
  });

  if (!access.has('CREATE_ISSUES')) {
    return (
      <PageContainer width="narrow">
        <EmptyState
          icon={LockIcon}
          title="You can’t open issues here"
          description="Your roles in this team don’t include opening issues. Ask a team admin if you need to."
          action={
            <Button asChild variant="outline">
              <Link to={`${base}/issues`}>Back to issues</Link>
            </Button>
          }
        />
      </PageContainer>
    );
  }

  const addAttachment = (attachment: Attachment) =>
    setAttachments((current) => [...current, attachment]);

  return (
    <PageContainer width="narrow">
      <UnsavedChangesGuard when={dirty && created === null} what="issue" />
      <BackLink to={`${base}/issues`} label="Issues" />
      <form
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
        className="grid gap-5"
        aria-labelledby="new-issue-heading"
      >
        <div>
          <h1 id="new-issue-heading" className="text-lg font-semibold tracking-tight">
            New issue
          </h1>
          <p className="text-sm text-muted-foreground">
            Report a bug, ask a question or suggest an idea. Mention people with @.
          </p>
        </div>

        <FormField label="Title" error={titleError}>
          {(field) => (
            <Input
              {...field}
              ref={titleRef}
              autoFocus
              value={title}
              maxLength={200}
              onChange={(event) => {
                setTitle(event.target.value);
                if (titleError) setTitleError(null);
              }}
              placeholder="A short summary, e.g. “Export fails for large projects”"
            />
          )}
        </FormField>

        <div className="grid gap-1.5">
          <p className="text-sm leading-none font-medium">Description</p>
          <RichTextEditor
            value={body}
            onChange={setBody}
            onSubmit={submit}
            teamId={team.id}
            onAttach={addAttachment}
            variant="full"
            label="Description"
            placeholder="What happened, what did you expect, and how can someone reproduce it? Type / for blocks, @ to mention, paste or drop images."
            className="min-h-56"
          />
        </div>

        <div className="grid gap-2">
          <p className="text-sm leading-none font-medium">Attachments</p>
          <AttachmentList
            attachments={attachments}
            removeMode="draft"
            canDelete={() => true}
            onDelete={(attachment) =>
              setAttachments((current) => current.filter((item) => item.id !== attachment.id))
            }
          />
          <AttachmentUploader teamId={team.id} onUploaded={addAttachment} />
        </div>

        <div className="grid gap-2">
          <p className="text-sm leading-none font-medium">Labels</p>
          <div>
            <LabelPicker
              labels={labels.data ?? []}
              value={labelIds}
              onChange={setLabelIds}
              onCreate={createLabel}
              disabled={labels.isPending}
            />
          </div>
        </div>

        {create.error && !titleError ? (
          <p role="alert" className="text-sm text-destructive">
            {errorMessage(create.error)}
          </p>
        ) : null}

        <div className="flex flex-wrap items-center justify-end gap-2 border-t pt-4">
          <span className="mr-auto hidden items-center gap-1 text-xs text-muted-foreground sm:inline-flex">
            <Kbd keys="mod+enter" /> to create
          </span>
          <Button asChild variant="outline">
            <Link to={`${base}/issues`}>Cancel</Link>
          </Button>
          <Button type="submit" disabled={create.isPending || created !== null}>
            {create.isPending ? <Spinner /> : null}
            Create issue
          </Button>
        </div>
      </form>
    </PageContainer>
  );
}
