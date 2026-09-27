import { Cron } from 'croner';
import type { AppDeps } from '../context';
import { agentActionJobs } from './agentActions';
import { backupJobs } from './backups';
import { claimJobs } from './claims';
import { purgeJobs } from './purge';
import type { JobDefinition } from './types';

export type { JobDefinition } from './types';

/** Every scheduled job (SPEC §5 Jobs). */
export const allJobs: readonly JobDefinition[] = [
  ...claimJobs,
  ...purgeJobs,
  ...backupJobs,
  ...agentActionJobs,
];

export interface JobScheduler {
  stop(): void;
}

/**
 * Schedules jobs in-process. A run never overlaps the previous one (`protect`), and failures are
 * logged without stopping the schedule.
 */
export function startJobs(deps: AppDeps, jobs: readonly JobDefinition[] = allJobs): JobScheduler {
  const crons = jobs.map(
    (job) =>
      new Cron(
        job.schedule,
        {
          name: job.name,
          protect: true,
          catch: (error) => deps.logger.error({ err: error, job: job.name }, 'job failed'),
        },
        async () => {
          const started = performance.now();
          await job.run(deps);
          deps.logger.debug(
            { job: job.name, ms: Math.round(performance.now() - started) },
            'job finished',
          );
        },
      ),
  );
  deps.logger.info({ jobs: jobs.map((job) => job.name) }, 'jobs scheduled');
  return {
    stop() {
      for (const cron of crons) cron.stop();
    },
  };
}
