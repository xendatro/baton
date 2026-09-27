import { Hono } from 'hono';
import { z } from 'zod';
import { idSchema } from '@shared/schemas/common';
import {
  githubContentsQuerySchema,
  githubReadmeQuerySchema,
  githubRepoFileQuerySchema,
  readmeSourceSchema,
} from '@shared/schemas/github';
import type { AppEnv } from '../context';
import { validateJson, validateParams, validateQuery } from '../lib/validate';
import { requireActor } from '../middleware/actor';
import {
  completeGithubInstall,
  disconnectGithub,
  getGithubReadme,
  getGithubReadmeImage,
  getGithubStatus,
  githubSetupRedirect,
  listGithubContents,
  listGithubRepos,
  setReadmeSource,
  startGithubInstall,
} from '../services/github';

/**
 * GitHub (repository READMEs): a team's connected accounts, the install and OAuth callbacks, the
 * README source picker, and a project's GitHub README with its images.
 * Owner: projects module. Paths are relative to /api and declared in full in this file.
 */
export const githubRoutes = new Hono<AppEnv>();

const teamParams = validateParams(z.object({ teamId: idSchema }));
const installationParams = validateParams(z.object({ teamId: idSchema, installationId: idSchema }));
const projectParams = validateParams(z.object({ projectId: idSchema }));
const callbackQuery = validateQuery(
  z.object({
    installation_id: z.string().max(40).optional(),
    setup_action: z.string().max(40).optional(),
    code: z.string().max(200).optional(),
    state: z.string().max(2000).optional(),
  }),
);

githubRoutes.get('/teams/:teamId/github', teamParams, (c) =>
  c.json(getGithubStatus(c.var.deps, requireActor(c), c.req.valid('param').teamId)),
);

githubRoutes.post('/teams/:teamId/github/install', teamParams, (c) =>
  c.json(startGithubInstall(c.var.deps, requireActor(c), c.req.valid('param').teamId)),
);

githubRoutes.delete('/teams/:teamId/github/:installationId', installationParams, (c) => {
  const { teamId, installationId } = c.req.valid('param');
  disconnectGithub(c.var.deps, requireActor(c), teamId, installationId);
  return c.json({ ok: true as const });
});

githubRoutes.get('/teams/:teamId/github/repos', teamParams, async (c) =>
  c.json(await listGithubRepos(c.var.deps, requireActor(c), c.req.valid('param').teamId)),
);

githubRoutes.get(
  '/teams/:teamId/github/:installationId/contents',
  installationParams,
  validateQuery(githubContentsQuerySchema),
  async (c) => {
    const { teamId, installationId } = c.req.valid('param');
    return c.json(
      await listGithubContents(
        c.var.deps,
        requireActor(c),
        teamId,
        installationId,
        c.req.valid('query'),
      ),
    );
  },
);

/** GitHub's "Setup URL": after installing, on to GitHub's OAuth page to check the person. */
githubRoutes.get('/github/setup', callbackQuery, (c) =>
  c.redirect(githubSetupRedirect(c.var.deps, requireActor(c), c.req.valid('query'))),
);

/** GitHub's OAuth callback: saves the installation, back to the team's Integrations settings. */
githubRoutes.get('/github/verify', callbackQuery, async (c) =>
  c.redirect(await completeGithubInstall(c.var.deps, requireActor(c), c.req.valid('query'))),
);

githubRoutes.put(
  '/projects/:projectId/readme-source',
  projectParams,
  validateJson(z.object({ readmeSource: readmeSourceSchema.nullable() })),
  async (c) =>
    c.json(
      await setReadmeSource(
        c.var.deps,
        requireActor(c),
        c.req.valid('param').projectId,
        c.req.valid('json').readmeSource,
      ),
    ),
);

githubRoutes.get(
  '/projects/:projectId/readme/github',
  projectParams,
  validateQuery(githubReadmeQuerySchema),
  async (c) =>
    c.json(
      await getGithubReadme(
        c.var.deps,
        requireActor(c),
        c.req.valid('param').projectId,
        c.req.valid('query').path,
      ),
    ),
);

githubRoutes.get(
  '/projects/:projectId/readme/github/image',
  projectParams,
  validateQuery(githubRepoFileQuerySchema),
  async (c) => {
    const { bytes, contentType } = await getGithubReadmeImage(
      c.var.deps,
      requireActor(c),
      c.req.valid('param').projectId,
      c.req.valid('query').path,
    );
    return c.body(bytes, 200, {
      'content-type': contentType,
      'cache-control': 'private, max-age=300',
      'x-content-type-options': 'nosniff',
      // SVGs can carry scripts: never run anything when one is opened directly.
      'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
    });
  },
);
