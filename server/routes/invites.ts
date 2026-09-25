import { Hono } from 'hono';
import { z } from 'zod';
import { idSchema } from '@shared/schemas/common';
import { createInviteInputSchema, inviteCodeSchema } from '@shared/schemas/teams';
import type { AppEnv } from '../context';
import { validateJson, validateParams } from '../lib/validate';
import { requireActor } from '../middleware/actor';
import {
  acceptInvite,
  createInvite,
  listInvites,
  previewInvite,
  revokeInvite,
} from '../services/invites';

/**
 * Invite links: create, list, revoke, preview and accept (/join/:code).
 * Owner: teams module. Paths are relative to /api and declared in full in this file.
 */
export const inviteRoutes = new Hono<AppEnv>();

const teamParams = validateParams(z.object({ teamId: idSchema }));
const inviteParams = validateParams(z.object({ teamId: idSchema, inviteId: idSchema }));
const codeParams = validateParams(z.object({ code: inviteCodeSchema }));

inviteRoutes.get('/teams/:teamId/invites', teamParams, (c) =>
  c.json(listInvites(c.var.deps, requireActor(c), c.req.valid('param').teamId)),
);

inviteRoutes.post(
  '/teams/:teamId/invites',
  teamParams,
  validateJson(createInviteInputSchema),
  (c) =>
    c.json(
      createInvite(c.var.deps, requireActor(c), c.req.valid('param').teamId, c.req.valid('json')),
      201,
    ),
);

inviteRoutes.delete('/teams/:teamId/invites/:inviteId', inviteParams, (c) => {
  const { teamId, inviteId } = c.req.valid('param');
  return c.json(revokeInvite(c.var.deps, requireActor(c), teamId, inviteId));
});

inviteRoutes.get('/invites/:code', codeParams, (c) =>
  c.json(previewInvite(c.var.deps, requireActor(c), c.req.valid('param').code)),
);

inviteRoutes.post('/invites/:code/accept', codeParams, (c) =>
  c.json(acceptInvite(c.var.deps, requireActor(c), c.req.valid('param').code)),
);
