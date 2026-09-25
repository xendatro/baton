import type { MiddlewareHandler } from 'hono';
import type { AppEnv } from '../context';
import { errors } from '../lib/errors';
import { authenticateApiKey } from '../services/apiKeys';

/**
 * MCP authentication (SPEC §5.1): `Authorization: Bearer bat_…` only. Missing or invalid keys get
 * HTTP 401 with `WWW-Authenticate: Bearer`, so MCP clients know to send a key. The actor acts via
 * the key with source `mcp`.
 */
export function mcpAuth(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const header = c.req.header('authorization') ?? '';
    const match = /^Bearer[ ]+(\S+)[ ]*$/i.exec(header);
    const authenticated = match?.[1] ? authenticateApiKey(c.var.deps, match[1]) : null;
    if (!authenticated) {
      const error = header
        ? errors.unauthorized('Invalid, expired or revoked API key')
        : errors.unauthorized('Send an API key: Authorization: Bearer bat_…');
      const challenge = header
        ? 'Bearer realm="baton", error="invalid_token"'
        : 'Bearer realm="baton"';
      return c.json(error.toJSON(), 401, { 'WWW-Authenticate': challenge });
    }
    c.set('actor', { userId: authenticated.userId, source: 'mcp', key: authenticated.key });
    return next();
  };
}
