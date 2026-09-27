import { sweepListenerSessions } from '../services/agentJobs';
import { sweepPresence } from '../services/presence';
import type { JobDefinition } from './types';

/**
 * Agent listener jobs (docs/design/agents-and-pipelines.md §4): every 15 s, put the claimed jobs
 * of listener sessions not seen for 90 s back in the queue, and publish who went offline
 * (people without a live-updates connection for 60 s, agents without a listener for 90 s).
 */
export const agentJobs: JobDefinition[] = [
  {
    name: 'agent-listeners',
    schedule: '*/15 * * * * *',
    run(deps) {
      sweepListenerSessions(deps);
      sweepPresence(deps);
    },
  },
];
