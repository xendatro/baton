import { FolderIcon, FolderOpenIcon, FolderXIcon } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { z } from 'zod';
import type { DesktopRepoCheck } from '@shared/desktopBridge';
import { EmptyState } from '@web/components/common/EmptyState';
import { PageContainer } from '@web/components/common/PageContainer';
import { PageHeader } from '@web/components/common/PageHeader';
import { Badge } from '@web/components/ui/badge';
import { Button } from '@web/components/ui/button';
import { Skeleton } from '@web/components/ui/skeleton';
import { api, errorMessage } from '@web/lib/api';
import { useMe } from '@web/lib/auth';
import { desktopBridge, useDesktopState } from '@web/lib/desktop';
import { useDocumentTitle } from '@web/lib/title';
import { DesktopOnly } from './common';

/**
 * `/desktop/folders`: which folder on this computer each project's jobs run in (BAT-26). Paths
 * are this computer's alone. A project without a folder gets no jobs here; "No folder" runs them
 * in a scratch folder the app makes. When the project names its repository, the folder's git
 * remote is checked against it.
 */
export default function DesktopFoldersPage() {
  useDocumentTitle(['Folders']);
  return (
    <DesktopOnly>
      <Folders />
    </DesktopOnly>
  );
}

const repoSchema = z.object({ repoUrl: z.string().nullable().optional() });

async function repoUrlOf(projectId: string): Promise<string | null> {
  const project = await api.get(`/api/projects/${encodeURIComponent(projectId)}`, {
    schema: repoSchema,
  });
  return project.repoUrl ?? null;
}

function RepoNote({ check }: { check: DesktopRepoCheck | null | undefined }) {
  if (!check) return null;
  switch (check.state) {
    case 'match':
      return <Badge variant="secondary">Repository matches</Badge>;
    case 'mismatch':
      return (
        <Badge variant="destructive">
          A different repository: {check.remote} (the project says {check.expected})
        </Badge>
      );
    case 'not-a-repo':
      return <Badge variant="outline">Not a git repository</Badge>;
    case 'no-repo-url':
      return <Badge variant="outline">The project doesn’t name its repository</Badge>;
  }
}

function Folders() {
  const me = useMe();
  const { state } = useDesktopState();
  const [checks, setChecks] = useState<Record<string, DesktopRepoCheck | null>>({});
  const projects = (me.data?.teams ?? []).flatMap((team) =>
    team.projects.map((project) => ({
      id: project.id,
      label: `${team.slug}/${project.key} — ${project.name}`,
      team: team.name,
    })),
  );
  const folders = state?.folders ?? {};
  const mappedKey = Object.keys(folders).sort().join(',');

  useEffect(() => {
    const bridge = desktopBridge();
    if (!bridge) return;
    for (const projectId of mappedKey.split(',').filter(Boolean)) {
      void repoUrlOf(projectId)
        .then((repoUrl) => bridge.checkRepo(projectId, repoUrl))
        .then((check) => setChecks((current) => ({ ...current, [projectId]: check })))
        .catch(() => undefined);
    }
  }, [mappedKey]);

  const pick = async (projectId: string, label: string) => {
    try {
      const check = await desktopBridge()?.pickFolder(projectId, label, await repoUrlOf(projectId));
      if (check !== undefined && check !== null) {
        setChecks((current) => ({ ...current, [projectId]: check }));
        toast.success('Folder set');
      }
    } catch (cause) {
      toast.error(errorMessage(cause));
    }
  };

  return (
    <PageContainer>
      <PageHeader
        title="Folders"
        description="Where each project’s jobs run on this computer. Paths are yours alone: others pick their own."
      />
      {me.isPending ? (
        <Skeleton className="h-40 rounded-lg" />
      ) : projects.length === 0 ? (
        <EmptyState
          icon={FolderIcon}
          title="No projects yet"
          description="Join or create a team and a project first."
        />
      ) : (
        <ul className="divide-y rounded-lg border bg-card" aria-label="Projects and their folders">
          {projects.map((project) => {
            const folder = folders[project.id];
            return (
              <li key={project.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium">{project.label}</p>
                  <p className="truncate text-sm text-muted-foreground">
                    {folder
                      ? (folder.path ?? 'No folder: a scratch folder the app makes')
                      : 'No folder yet: its jobs don’t run on this computer'}
                  </p>
                  {folder?.path ? <RepoNote check={checks[project.id]} /> : null}
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button size="sm" onClick={() => void pick(project.id, project.label)}>
                    <FolderOpenIcon aria-hidden="true" />
                    {folder?.path ? 'Change folder' : 'Choose folder'}
                  </Button>
                  {!folder || folder.path ? (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => void desktopBridge()?.useScratch(project.id, project.label)}
                    >
                      No folder
                    </Button>
                  ) : null}
                  {folder ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      aria-label={`Stop running ${project.label} here`}
                      onClick={() => void desktopBridge()?.unmap(project.id)}
                    >
                      <FolderXIcon aria-hidden="true" />
                      Remove
                    </Button>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </PageContainer>
  );
}
