/** Set by build.mjs (esbuild `define`): the git commit of this build, 7 characters. */
declare const BATON_DESKTOP_COMMIT: string | undefined;

/** The git commit the app was built from (BAT-31), or "dev" when unknown (tests, tsx). */
export const COMMIT: string =
  typeof BATON_DESKTOP_COMMIT === 'string' && BATON_DESKTOP_COMMIT ? BATON_DESKTOP_COMMIT : 'dev';
