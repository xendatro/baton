import { ChevronRightIcon, FileTextIcon, FolderIcon, LockIcon, PencilIcon } from 'lucide-react';
import { useId, useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { toast } from 'sonner';
import { isMarkdownPath, type ReadmeSource } from '@shared/schemas/github';
import type { Project } from '@shared/schemas/projects';
import { ErrorState } from '@web/components/common/ErrorState';
import { GitHubIcon } from '@web/components/common/GitHubIcon';
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
import { RadioGroup, RadioGroupItem } from '@web/components/ui/radio-group';
import { Skeleton } from '@web/components/ui/skeleton';
import { errorMessage } from '@web/lib/api';
import { cn } from '@web/lib/utils';
import {
  useGithubContents,
  useGithubRepos,
  useGithubStatus,
  useSetReadmeSource,
} from './githubQueries';

/**
 * Where a project's README comes from: written in Baton, one Markdown file of a connected GitHub
 * repository, or a folder of Markdown files (shown as a tree, starting at a page you pick).
 */

type Kind = 'inline' | 'file' | 'folder';

export function ReadmeSourceDialog({
  open,
  onOpenChange,
  project,
  teamSlug,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  project: Project;
  teamSlug: string;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        {open ? (
          <SourceForm project={project} teamSlug={teamSlug} onClose={() => onOpenChange(false)} />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function SourceForm({
  project,
  teamSlug,
  onClose,
}: {
  project: Project;
  teamSlug: string;
  onClose: () => void;
}) {
  const current = project.readmeSource ?? null;
  const [kind, setKind] = useState<Kind>(current ? current.type : 'inline');
  const [repoKey, setRepoKey] = useState(
    current ? `${current.installationId}:${current.repo}` : '',
  );
  const [ref, setRef] = useState(current?.ref ?? '');
  const [folder, setFolder] = useState(
    current ? (current.type === 'folder' ? current.path : parentOf(current.path)) : '',
  );
  const [filePath, setFilePath] = useState(current?.type === 'file' ? current.path : '');
  const [entry, setEntry] = useState(current?.type === 'folder' ? (current.entry ?? '') : '');
  const [error, setError] = useState<string | null>(null);
  const status = useGithubStatus(project.teamId);
  const connected = (status.data?.installations.length ?? 0) > 0;
  const repos = useGithubRepos(project.teamId, kind !== 'inline' && connected);
  const save = useSetReadmeSource(project.id);
  const repoId = useId();
  const refId = useId();
  const entryId = useId();

  const repo = repos.data?.repos.find(
    (candidate) => `${candidate.installationId}:${candidate.fullName}` === repoKey,
  );
  const contents = useGithubContents(
    project.teamId,
    kind !== 'inline' && repo
      ? { installationId: repo.installationId, repo: repo.fullName, path: folder }
      : null,
  );
  const markdownHere = (contents.data?.entries ?? []).filter(
    (entryItem) => entryItem.type === 'file' && isMarkdownPath(entryItem.name),
  );

  const submit = () => {
    let source: ReadmeSource | null = null;
    if (kind !== 'inline') {
      if (!repo) {
        setError('Choose a repository');
        return;
      }
      if (kind === 'file' && !filePath) {
        setError('Choose a Markdown file');
        return;
      }
      source = {
        kind: 'github',
        installationId: repo.installationId,
        repo: repo.fullName,
        ref: ref.trim() || null,
        type: kind,
        path: kind === 'file' ? filePath : folder,
        entry: kind === 'folder' && entry ? entry : null,
      };
    }
    setError(null);
    save.mutate(source, {
      onSuccess: () => {
        toast.success(
          source ? `The README now comes from ${source.repo}` : 'The README is written here again',
        );
        onClose();
      },
      onError: (cause) => setError(errorMessage(cause)),
    });
  };

  return (
    <div className="grid gap-5">
      <DialogHeader>
        <DialogTitle>README source</DialogTitle>
        <DialogDescription>
          Write the README here, or show Markdown from a GitHub repository (it stays up to date with
          the repository).
        </DialogDescription>
      </DialogHeader>

      <RadioGroup
        value={kind}
        onValueChange={(value) => setKind(value as Kind)}
        aria-label="README source"
        className="grid gap-2 sm:grid-cols-3"
      >
        <KindOption value="inline" icon={<PencilIcon />} label="Write it here" />
        <KindOption value="file" icon={<FileTextIcon />} label="A file on GitHub" />
        <KindOption value="folder" icon={<FolderIcon />} label="A folder on GitHub" />
      </RadioGroup>

      {kind === 'inline' ? (
        <p className="text-sm text-muted-foreground">
          {current
            ? 'The README you wrote before is kept and shows again.'
            : 'The README is written in Baton, with the editor on the overview.'}
        </p>
      ) : status.isPending ? (
        <Skeleton className="h-24" />
      ) : !status.data?.enabled ? (
        <p className="rounded-md bg-muted px-3 py-2 text-sm">
          GitHub isn’t set up on this Baton server yet.
        </p>
      ) : !connected ? (
        <div className="grid gap-2 rounded-md bg-muted px-3 py-3 text-sm">
          <p>Connect a GitHub account or organization to the team first.</p>
          <Button asChild size="sm" className="justify-self-start">
            <Link to={`/t/${teamSlug}/settings/integrations`}>
              <GitHubIcon />
              Team settings → Integrations
            </Link>
          </Button>
        </div>
      ) : repos.isError ? (
        <ErrorState
          title="Couldn’t list the repositories"
          error={repos.error}
          onRetry={() => void repos.refetch()}
        />
      ) : (
        <div className="grid gap-4">
          <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_10rem]">
            <div className="grid gap-1.5">
              <Label htmlFor={repoId}>Repository</Label>
              <select
                id={repoId}
                value={repoKey}
                disabled={repos.isPending}
                onChange={(event) => {
                  setRepoKey(event.target.value);
                  setFolder('');
                  setFilePath('');
                  setEntry('');
                }}
                className="h-9 w-full rounded-md border border-input bg-transparent px-2 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 dark:bg-input/30"
              >
                <option value="">{repos.isPending ? 'Loading…' : 'Choose a repository'}</option>
                {repos.data?.repos.map((item) => (
                  <option
                    key={`${item.installationId}:${item.fullName}`}
                    value={`${item.installationId}:${item.fullName}`}
                  >
                    {item.fullName}
                    {item.private ? ' (private)' : ''}
                  </option>
                ))}
              </select>
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor={refId}>Branch</Label>
              <Input
                id={refId}
                value={ref}
                onChange={(event) => setRef(event.target.value)}
                placeholder={repo?.defaultBranch ?? 'default'}
                autoComplete="off"
              />
            </div>
          </div>

          {repo ? (
            <div className="grid gap-2">
              <div className="flex flex-wrap items-center gap-1 text-sm">
                {repo.private ? (
                  <LockIcon className="size-3.5 text-muted-foreground" aria-label="Private" />
                ) : null}
                <Breadcrumbs repo={repo.fullName} path={folder} onPick={setFolder} />
              </div>
              <div className="max-h-64 overflow-y-auto rounded-md border">
                {contents.isPending ? (
                  <div className="grid gap-2 p-3">
                    <Skeleton className="h-4 w-1/2" />
                    <Skeleton className="h-4 w-2/3" />
                  </div>
                ) : contents.isError ? (
                  <p className="p-3 text-sm text-destructive">{errorMessage(contents.error)}</p>
                ) : (
                  <ul aria-label="Files and folders">
                    {contents.data.entries.length === 0 ? (
                      <li className="p-3 text-sm text-muted-foreground">Empty folder</li>
                    ) : null}
                    {contents.data.entries.map((item) => {
                      const markdown = item.type === 'file' && isMarkdownPath(item.name);
                      const chosen = kind === 'file' && item.path === filePath;
                      const clickable = item.type === 'dir' || (kind === 'file' && markdown);
                      return (
                        <li key={item.path}>
                          <button
                            type="button"
                            disabled={!clickable}
                            aria-pressed={kind === 'file' && markdown ? chosen : undefined}
                            onClick={() => {
                              if (item.type === 'dir') {
                                setFolder(item.path);
                                setEntry('');
                              } else {
                                setFilePath(item.path);
                              }
                            }}
                            className={cn(
                              'flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm outline-none hover:bg-accent focus-visible:bg-accent disabled:cursor-default disabled:text-muted-foreground disabled:opacity-60 disabled:hover:bg-transparent',
                              chosen && 'bg-primary/10 font-medium text-primary',
                            )}
                          >
                            {item.type === 'dir' ? (
                              <FolderIcon className="size-4 text-sky-600" aria-hidden="true" />
                            ) : (
                              <FileTextIcon className="size-4" aria-hidden="true" />
                            )}
                            <span className="truncate">{item.name}</span>
                            {item.type === 'dir' ? (
                              <ChevronRightIcon className="ml-auto size-4" aria-hidden="true" />
                            ) : null}
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </div>
              {kind === 'file' ? (
                <p className="text-sm text-muted-foreground">
                  {filePath ? (
                    <>
                      Showing <code className="text-xs">{filePath}</code>
                    </>
                  ) : (
                    'Choose a Markdown file.'
                  )}
                </p>
              ) : (
                <div className="grid gap-1.5">
                  <p className="text-sm text-muted-foreground">
                    Every Markdown file in <code className="text-xs">{folder || '/'}</code> and its
                    subfolders is shown as a tree.
                  </p>
                  <Label htmlFor={entryId}>First page</Label>
                  <select
                    id={entryId}
                    value={entry}
                    onChange={(event) => setEntry(event.target.value)}
                    className="h-9 w-full max-w-sm rounded-md border border-input bg-transparent px-2 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 dark:bg-input/30"
                  >
                    <option value="">Automatic (README.md or index.md)</option>
                    {markdownHere.map((item) => (
                      <option key={item.path} value={item.path}>
                        {item.name}
                      </option>
                    ))}
                    {entry && !markdownHere.some((item) => item.path === entry) ? (
                      <option value={entry}>{entry}</option>
                    ) : null}
                  </select>
                </div>
              )}
            </div>
          ) : null}
        </div>
      )}

      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onClose} disabled={save.isPending}>
          Cancel
        </Button>
        <Button type="button" onClick={submit} disabled={save.isPending}>
          {save.isPending ? <Spinner /> : null}
          Save
        </Button>
      </DialogFooter>
    </div>
  );
}

function parentOf(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash < 0 ? '' : path.slice(0, slash);
}

function KindOption({ value, icon, label }: { value: Kind; icon: ReactNode; label: string }) {
  const id = useId();
  return (
    <label
      htmlFor={id}
      className="flex cursor-pointer items-center gap-2 rounded-md border px-3 py-2 text-sm has-[[data-state=checked]]:border-primary has-[[data-state=checked]]:bg-primary/5 [&_svg]:size-4 [&_svg]:text-muted-foreground"
    >
      <RadioGroupItem id={id} value={value} />
      {icon}
      {label}
    </label>
  );
}

function Breadcrumbs({
  repo,
  path,
  onPick,
}: {
  repo: string;
  path: string;
  onPick: (path: string) => void;
}) {
  const parts = path ? path.split('/') : [];
  return (
    <nav aria-label="Folder" className="flex min-w-0 flex-wrap items-center gap-1">
      <button
        type="button"
        onClick={() => onPick('')}
        className="rounded font-medium outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
      >
        {repo}
      </button>
      {parts.map((part, index) => (
        <span key={`${index}:${part}`} className="flex items-center gap-1">
          <span className="text-muted-foreground">/</span>
          <button
            type="button"
            onClick={() => onPick(parts.slice(0, index + 1).join('/'))}
            className="rounded outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
          >
            {part}
          </button>
        </span>
      ))}
    </nav>
  );
}
