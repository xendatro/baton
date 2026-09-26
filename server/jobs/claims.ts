import type { AppDeps } from '../context';
import { expireClaims } from '../services/claims';
import type { JobDefinition } from './types';

/** Name and schedule of the claim sweeper (SPEC §1.8: expired claims are swept every minute). */
export const CLAIM_SWEEP_JOB = { name: 'expire-claims', schedule: '* * * * *' } as const;

/**
 * Expires task claims whose lease ended before `now`: clears the claim and writes a
 * `task.claim_expired` system activity row per task. Returns how many claims expired.
 */
export type ClaimSweeper = (deps: AppDeps, now: Date) => number;

/** The claim-sweeper job for a sweeper implementation (logs only when claims expired). */
export function claimSweepJob(sweep: ClaimSweeper): JobDefinition {
  return {
    ...CLAIM_SWEEP_JOB,
    run(deps) {
      const expired = sweep(deps, new Date());
      if (expired > 0) deps.logger.info({ expired }, 'expired task claims released');
    },
  };
}

/** Claim jobs (owner: tasks module): the sweeper that expires stale claims every minute. */
export const claimJobs: JobDefinition[] = [claimSweepJob(expireClaims)];
