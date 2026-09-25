import type { JobDefinition } from './types';

/**
 * Claim jobs (owner: tasks module): expire claims past `claimExpiresAt` every minute, audited as
 * `task.claim_expired`.
 */
export const claimJobs: JobDefinition[] = [];
