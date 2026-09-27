import { expireActionRequests } from '../services/agentActions';
import type { JobDefinition } from './types';

/**
 * Agent sign-off requests (design §6): pending requests expire after 7 days. Checked hourly
 * (reads treat an overdue request as expired in between).
 */
export const agentActionJobs: JobDefinition[] = [
  {
    name: 'expire-agent-action-requests',
    schedule: '17 * * * *',
    run(deps) {
      const expired = expireActionRequests(deps, new Date());
      if (expired > 0) deps.logger.info({ expired }, 'expired agent action requests');
    },
  },
];
