import { Hono, type Context, type MiddlewareHandler } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { deleteCookie } from 'hono/cookie';
import { z } from 'zod';
import {
  AVATAR_MAX_BYTES,
  changePasswordInputSchema,
  deleteAccountInputSchema,
  setPasswordInputSchema,
  SOCIAL_PROVIDERS,
  updateAgentSettingsInputSchema,
  updateProfileInputSchema,
} from '@shared/schemas/account';
import { idSchema } from '@shared/schemas/common';
import type { AppEnv } from '../context';
import { errors } from '../lib/errors';
import { parseMultipartBody, validateJson, validateParams } from '../lib/validate';
import { requireActor } from '../middleware/actor';
import { byUser, rateLimit } from '../middleware/rateLimit';
import {
  changePassword,
  deleteAccount,
  disconnectAccount,
  getConnections,
  listSessions,
  removeAvatar,
  revokeOtherSessions,
  revokeSession,
  setAvatar,
  setPassword,
  updateProfile,
} from '../services/account';
import { getAgentSettings, updateAgentSettings } from '../services/agents';

/**
 * Account: profile, username, avatar, theme, password, sessions, sign-in methods, deletion.
 * Owner: account module. Paths are relative to /api and declared in full in this file.
 *
 * Password, session, sign-in method and deletion endpoints need a web session: an API key (an
 * agent or script) can't use them (SPEC §1.14), nor the agent settings. Profile and avatar
 * changes work with keys too, and change the key owner's profile.
 */
export const accountRoutes = new Hono<AppEnv>();

const webOnly: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (requireActor(c).source !== 'web') {
    throw errors.forbidden('This can only be done from the web app, signed in with a session');
  }
  return next();
};

function currentSessionId(c: Context<AppEnv>): string | null {
  return c.var.sessionId;
}

accountRoutes.patch('/me', validateJson(updateProfileInputSchema), (c) =>
  c.json(updateProfile(c.var.deps, requireActor(c), c.req.valid('json'))),
);

// ---------------------------------------------------------------------------------------------
// Your agent member (agents A): pause it, choose how much of its activity reaches your inbox
// ---------------------------------------------------------------------------------------------

accountRoutes.get('/me/agent', webOnly, (c) =>
  c.json(getAgentSettings(c.var.deps, requireActor(c))),
);

accountRoutes.patch('/me/agent', webOnly, validateJson(updateAgentSettingsInputSchema), (c) =>
  c.json(updateAgentSettings(c.var.deps, requireActor(c), c.req.valid('json'))),
);

// ---------------------------------------------------------------------------------------------
// Avatar
// ---------------------------------------------------------------------------------------------

/** Multipart overhead allowed on top of the avatar size limit. */
const MULTIPART_OVERHEAD_BYTES = 64 * 1024;

const avatarSizeLimit: MiddlewareHandler<AppEnv> = (c, next) => {
  const maxBytes = Math.min(AVATAR_MAX_BYTES, c.var.deps.env.maxUploadMb * 1024 * 1024);
  return bodyLimit({
    maxSize: maxBytes + MULTIPART_OVERHEAD_BYTES,
    onError: (ctx) =>
      ctx.json(
        errors
          .payloadTooLarge(`Avatars can be at most ${Math.floor(maxBytes / 1024 / 1024)} MB`)
          .toJSON(),
        413,
      ),
  })(c, next);
};

const AVATAR_FORMAT_MESSAGE = 'Send the image as multipart/form-data in the "file" field';

accountRoutes.post(
  '/me/avatar',
  rateLimit({ name: 'uploads', key: byUser }),
  avatarSizeLimit,
  async (c) => {
    const actor = requireActor(c);
    const body = await parseMultipartBody(c, AVATAR_FORMAT_MESSAGE);
    const file = body.file;
    if (!(file instanceof File)) {
      throw errors.validation(AVATAR_FORMAT_MESSAGE);
    }
    const profile = await setAvatar(c.var.deps, actor, {
      filename: file.name,
      bytes: new Uint8Array(await file.arrayBuffer()),
    });
    return c.json(profile);
  },
);

accountRoutes.delete('/me/avatar', (c) => c.json(removeAvatar(c.var.deps, requireActor(c))));

// ---------------------------------------------------------------------------------------------
// Password
// ---------------------------------------------------------------------------------------------

accountRoutes.post('/me/password', webOnly, validateJson(changePasswordInputSchema), async (c) =>
  c.json(
    await changePassword(c.var.deps, requireActor(c), {
      ...c.req.valid('json'),
      currentSessionId: currentSessionId(c),
    }),
  ),
);

accountRoutes.post('/me/password/set', webOnly, validateJson(setPasswordInputSchema), async (c) =>
  c.json(
    await setPassword(c.var.deps, requireActor(c), {
      ...c.req.valid('json'),
      currentSessionId: currentSessionId(c),
    }),
  ),
);

// ---------------------------------------------------------------------------------------------
// Sessions and sign-in methods
// ---------------------------------------------------------------------------------------------

accountRoutes.get('/me/sessions', webOnly, (c) =>
  c.json(listSessions(c.var.deps, requireActor(c), { currentSessionId: currentSessionId(c) })),
);

accountRoutes.post('/me/sessions/revoke-others', webOnly, (c) =>
  c.json(
    revokeOtherSessions(c.var.deps, requireActor(c), { currentSessionId: currentSessionId(c) }),
  ),
);

accountRoutes.delete('/me/sessions/:id', webOnly, validateParams(z.object({ id: idSchema })), (c) =>
  c.json(
    revokeSession(c.var.deps, requireActor(c), {
      sessionId: c.req.valid('param').id,
      currentSessionId: currentSessionId(c),
    }),
  ),
);

accountRoutes.get('/me/connections', webOnly, async (c) =>
  c.json(await getConnections(c.var.deps, requireActor(c))),
);

accountRoutes.delete(
  '/me/connections/:provider',
  webOnly,
  validateParams(z.object({ provider: z.enum(SOCIAL_PROVIDERS) })),
  (c) => c.json(disconnectAccount(c.var.deps, requireActor(c), c.req.valid('param'))),
);

// ---------------------------------------------------------------------------------------------
// Deletion
// ---------------------------------------------------------------------------------------------

accountRoutes.post('/me/delete', webOnly, validateJson(deleteAccountInputSchema), async (c) => {
  const result = await deleteAccount(c.var.deps, requireActor(c), c.req.valid('json'));
  // The sessions are gone with the user; drop the browser's copies of the auth cookies too.
  const { authCookies } = await c.var.deps.auth.$context;
  for (const cookie of [
    authCookies.sessionToken,
    authCookies.sessionData,
    authCookies.dontRememberToken,
  ]) {
    deleteCookie(c, cookie.name, {
      path: cookie.attributes.path ?? '/',
      secure: cookie.attributes.secure,
      sameSite: 'Lax',
      httpOnly: true,
    });
  }
  return c.json(result);
});
