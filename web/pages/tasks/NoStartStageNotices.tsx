import { Link } from 'react-router';
import type { Pipeline } from '@shared/schemas/projects';
import { NoStartStageNotice } from '@web/components/common/NewTaskStages';
import { Button } from '@web/components/ui/button';
import { projectSettingsPath } from './settingsPaths';

/** BAT-34: the board's warnings: one per pipeline where no task can be created. */
export function NoStartStageNotices({
  blocked,
  named,
  projectBase,
  canManageStatuses,
}: {
  blocked: readonly Pipeline[];
  /** Name the pipeline (the project has several). */
  named: boolean;
  projectBase: string;
  canManageStatuses: boolean;
}) {
  if (blocked.length === 0) return null;
  return (
    <div className="mt-3 grid gap-2">
      {blocked.map((pipeline) => (
        <NoStartStageNotice
          key={pipeline.id}
          pipelineName={named ? pipeline.name : undefined}
          action={
            canManageStatuses ? (
              <Button asChild variant="outline" size="sm" className="h-7 bg-transparent">
                <Link to={projectSettingsPath(projectBase, 'pipelines', undefined, pipeline.id)}>
                  Edit stages
                </Link>
              </Button>
            ) : null
          }
        />
      ))}
    </div>
  );
}
