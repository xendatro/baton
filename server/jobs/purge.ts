import type { JobDefinition } from './types';

/**
 * Purge jobs (owner: core module): trash older than 30 days and orphaned files (daily 03:15),
 * pending uploads older than 24 h (hourly), expired sessions and verifications (daily).
 */
export const purgeJobs: JobDefinition[] = [];
