import {
  BookOpenIcon,
  ChevronRightIcon,
  ExternalLinkIcon,
  FileTextIcon,
  FolderIcon,
  GitBranchIcon,
  Settings2Icon,
} from 'lucide-react';
import { useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { isMarkdownPath } from '@shared/schemas/github';
import type { Project } from '@shared/schemas/projects';
import { ErrorState } from '@web/components/common/ErrorState';
import { MarkdownView } from '@web/components/markdown/MarkdownView';
import { Button } from '@web/components/ui/button';
import { Skeleton } from '@web/components/ui/skeleton';
import { cn } from '@web/lib/utils';
import { githubImageUrl, useGithubReadme } from './githubQueries';

/**
 * A project's README shown from GitHub: one Markdown file, or a folder of them with a file tree
 * (`?doc=<path>` picks the page, so pages can be linked and the back button works). Relative
 * links between the Markdown files stay inside the tree, relative images load through Baton,
 * and every other relative link opens on GitHub.
 */

/** `a/b/../c` → `a/c`; null when it climbs above the repository root. */
function normalize(path: string): string | null {
  const parts: string[] = [];
  for (const part of path.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else {
      parts.push(part);
    }
  }
  return parts.join('/');
}

function dirname(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash < 0 ? '' : path.slice(0, slash);
}

function isRelative(url: string): boolean {
  return !/^[a-z][a-z0-9+.-]*:/i.test(url) && !url.startsWith('//') && !url.startsWith('#');
}

interface TreeFolder {
  name: string;
  path: string;
  folders: TreeFolder[];
  files: Array<{ name: string; path: string }>;
}

function buildTree(files: ReadonlyArray<{ path: string; name: string }>, root: string): TreeFolder {
  const top: TreeFolder = { name: '', path: root, folders: [], files: [] };
  for (const file of files) {
    const relative =
      root && file.path.startsWith(`${root}/`) ? file.path.slice(root.length + 1) : file.path;
    const parts = relative.split('/');
    let folder = top;
    for (const part of parts.slice(0, -1)) {
      let next = folder.folders.find((candidate) => candidate.name === part);
      if (!next) {
        next = {
          name: part,
          path: folder.path ? `${folder.path}/${part}` : part,
          folders: [],
          files: [],
        };
        folder.folders.push(next);
      }
      folder = next;
    }
    folder.files.push({ name: file.name, path: file.path });
  }
  const sort = (folder: TreeFolder) => {
    folder.files.sort(
      (a, b) => readmeFirst(a.name) - readmeFirst(b.name) || a.name.localeCompare(b.name),
    );
    folder.folders.sort((a, b) => a.name.localeCompare(b.name));
    folder.folders.forEach(sort);
  };
  sort(top);
  return top;
}

function readmeFirst(name: string): number {
  return /^(readme|index)\./i.test(name) ? 0 : 1;
}

function displayName(name: string): string {
  return name.replace(/\.(md|markdown|mdx)$/i, '');
}

export function GithubReadme({
  project,
  canEdit,
  onChangeSource,
}: {
  project: Project;
  canEdit: boolean;
  onChangeSource: () => void;
}) {
  const source = project.readmeSource;
  const [params] = useSearchParams();
  const doc = params.get('doc');
  const readme = useGithubReadme(project.id, doc, source != null);
  const data = readme.data;
  const root = source?.type === 'folder' ? source.path : '';
  const tree = data?.tree ? buildTree(data.tree, root) : null;

  if (!source) return null;
  const location = `${source.repo}${source.path ? `/${source.path}` : ''}`;
  const repoUrl = `https://github.com/${source.repo}`;

  const rewriteUrl = (url: string, kind: 'link' | 'image'): string | null => {
    if (!data?.doc || !isRelative(url)) return null;
    const [target = '', hash = ''] = url.split('#');
    const clean = target.split('?')[0] ?? '';
    const resolved = clean.startsWith('/')
      ? normalize(clean)
      : normalize(`${dirname(data.doc.path)}/${clean}`);
    if (resolved === null) return null;
    if (kind === 'image') return githubImageUrl(project.id, resolved);
    if (clean === '') return null;
    if (isMarkdownPath(resolved) && data.tree?.some((file) => file.path === resolved)) {
      return `?doc=${encodeURIComponent(resolved)}${hash ? `#${hash}` : ''}`;
    }
    return `${repoUrl}/blob/${encodeURIComponent(data.ref)}/${resolved}${hash ? `#${hash}` : ''}`;
  };

  return (
    <div className="rounded-lg border bg-card">
      <div className="flex min-h-11 flex-wrap items-center justify-between gap-2 border-b px-4 py-2">
        <h2 id="readme-heading" className="flex min-w-0 items-center gap-2 text-sm font-semibold">
          <BookOpenIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          README
          <span className="min-w-0 truncate font-normal text-muted-foreground">
            from{' '}
            <a
              href={data?.htmlUrl ?? repoUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="hover:text-foreground hover:underline"
            >
              {location}
            </a>
          </span>
          {data ? (
            <span className="hidden items-center gap-1 text-xs font-normal text-muted-foreground sm:flex">
              <GitBranchIcon className="size-3" aria-hidden="true" />
              {data.ref}
            </span>
          ) : null}
        </h2>
        <div className="flex items-center gap-1">
          {data?.doc ? (
            <Button asChild variant="ghost" size="sm">
              <a href={data.doc.htmlUrl} target="_blank" rel="noopener noreferrer">
                <ExternalLinkIcon aria-hidden="true" />
                <span className="hidden sm:inline">Open on GitHub</span>
                <span className="sr-only sm:hidden">Open on GitHub</span>
              </a>
            </Button>
          ) : null}
          {canEdit ? (
            <Button variant="ghost" size="sm" onClick={onChangeSource}>
              <Settings2Icon aria-hidden="true" />
              Source
            </Button>
          ) : null}
        </div>
      </div>

      {readme.isPending ? (
        <div className="grid gap-3 px-4 py-5 sm:px-6" role="status" aria-label="Loading README">
          <Skeleton className="h-6 w-1/3" />
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-5/6" />
          <Skeleton className="h-4 w-2/3" />
        </div>
      ) : readme.isError ? (
        <div className="p-4">
          <ErrorState
            title="Couldn’t load the README from GitHub"
            error={readme.error}
            onRetry={() => void readme.refetch()}
          />
          {canEdit ? (
            <p className="mt-2 text-center text-sm text-muted-foreground">
              If it moved,{' '}
              <button type="button" className="underline" onClick={onChangeSource}>
                change the source
              </button>
              .
            </p>
          ) : null}
        </div>
      ) : (
        <div className={cn(tree && 'md:grid md:grid-cols-[14rem_minmax(0,1fr)]')}>
          {tree ? (
            <nav
              aria-label="README pages"
              className="border-b px-2 py-3 md:max-h-[70vh] md:overflow-y-auto md:border-r md:border-b-0"
            >
              <FolderItems folder={tree} current={readme.data.doc?.path ?? null} depth={0} />
              {readme.data.truncated ? (
                <p className="px-2 pt-2 text-xs text-muted-foreground">
                  Only the first {readme.data.tree?.length} pages are listed.
                </p>
              ) : null}
            </nav>
          ) : null}
          <div className="min-w-0 px-4 py-5 sm:px-6">
            {readme.data.doc ? (
              <MarkdownView
                key={readme.data.doc.path}
                markdown={readme.data.doc.content}
                teamId={project.teamId}
                rewriteUrl={rewriteUrl}
              />
            ) : (
              <p className="text-sm text-muted-foreground">This folder has no Markdown files.</p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function FolderItems({
  folder,
  current,
  depth,
}: {
  folder: TreeFolder;
  current: string | null;
  depth: number;
}) {
  return (
    <ul className="grid gap-px">
      {folder.files.map((file) => (
        <li key={file.path}>
          <Link
            to={`?doc=${encodeURIComponent(file.path)}`}
            aria-current={file.path === current ? 'page' : undefined}
            className={cn(
              'flex items-center gap-1.5 rounded-md py-1 pr-2 text-sm outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring',
              file.path === current ? 'bg-accent font-medium' : 'text-muted-foreground',
            )}
            style={{ paddingLeft: `${0.5 + depth * 0.75}rem` }}
          >
            <FileTextIcon className="size-3.5 shrink-0" aria-hidden="true" />
            <span className="truncate">{displayName(file.name)}</span>
          </Link>
        </li>
      ))}
      {folder.folders.map((child) => (
        <FolderNode key={child.path} folder={child} current={current} depth={depth} />
      ))}
    </ul>
  );
}

function FolderNode({
  folder,
  current,
  depth,
}: {
  folder: TreeFolder;
  current: string | null;
  depth: number;
}) {
  const containsCurrent = current !== null && current.startsWith(`${folder.path}/`);
  const [expanded, setExpanded] = useState(containsCurrent || depth === 0);
  return (
    <li>
      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => setExpanded(!expanded)}
        className="flex w-full items-center gap-1.5 rounded-md py-1 pr-2 text-left text-sm text-muted-foreground outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
        style={{ paddingLeft: `${0.5 + depth * 0.75}rem` }}
      >
        <ChevronRightIcon
          className={cn('size-3.5 shrink-0 transition-transform', expanded && 'rotate-90')}
          aria-hidden="true"
        />
        <FolderIcon className="size-3.5 shrink-0" aria-hidden="true" />
        <span className="truncate">{folder.name}</span>
      </button>
      {expanded ? <FolderItems folder={folder} current={current} depth={depth + 1} /> : null}
    </li>
  );
}
