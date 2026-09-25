import pkg from '../package.json' with { type: 'json' };

/** App version from package.json (inlined into the production bundle). */
export const VERSION: string = pkg.version;
