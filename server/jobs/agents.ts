import { sweepListenerSessions, sweepSettledJobs } from '../services/agentJobs';
import { sweepWorking } from '../services/agentWorking';
import { sweepPresence } from '../services/presence';
import type { JobDefinition } from './types';

/**
 * Agent listener jobs (docs/design/agents-and-pipelines.md §4): every 15 s, put the claimed jobs
 * of listener sessions not seen for 90 s back in the queue, and publish who went offline
 * (people without a live-updates connection for 60 s, agents without a listener for 90 s) and
 * which items agents stopped working on (BAT#42). Every
 * 5 minutes, clear held and waiting jobs whose task or issue finished (BAT#29) in ways the moves
 * don't report (a stage stops blocking its dependents, a project is deleted, …).
 */
export const agentJobs: JobDefinition[] = [
  {
    name: 'agent-listeners',
    schedule: '*/15 * * * * *',
    run(deps) {
      sweepListenerSessions(deps);
      sweepPresence(deps);
      // BAT#42: runner reports that went stale, jobs cancelled inside other changes.
      sweepWorking(deps);
    },
  },
  {
    name: 'agent-held-jobs',
    schedule: '0 */5 * * * *',
    run(deps) {
      sweepSettledJobs(deps);
    },
  },
];
