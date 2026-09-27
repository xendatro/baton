/** Set by vite.config.ts (`define`): the git commit of this web build, 7 characters. */
declare const __BATON_COMMIT__: string | undefined;

/** The git commit the web app was built from (BAT-31), or "dev" when unknown (tests). */
export const WEB_COMMIT: string =
  typeof __BATON_COMMIT__ === 'string' && __BATON_COMMIT__ ? __BATON_COMMIT__ : 'dev';
