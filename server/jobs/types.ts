import type { AppDeps } from '../context';

/** A scheduled in-process job (croner). */
export interface JobDefinition {
  name: string;
  /** Cron pattern in server local time, e.g. `30 3 * * *`. */
  schedule: string;
  run(deps: AppDeps): void | Promise<void>;
}
