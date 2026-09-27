import type { ActivityEntry } from '@shared/schemas/core';
import { describeUserAgent } from '@shared/userAgent';
import { isAgentUser } from '@web/lib/agentMembers';
import { pluralize } from '@web/lib/format';

/**
 * Plain-language lines for the security log (account-level activity rows): what happened, and
 * from where. Unknown actions fall back to their dotted name, so new server actions still show.
 */

export type SecurityEventKind =
  'sign-in' | 'account' | 'password' | 'connection' | 'api-key' | 'session' | 'profile' | 'agent';

export interface SecurityEventText {
  kind: SecurityEventKind;
  /** "Signed in with a password". */
  title: string;
  /** Context such as the browser and IP address, when known. */
  details: string[];
}

const PROVIDERS: Record<string, string> = { google: 'Google', github: 'GitHub', email: 'email' };

const THEME_LABELS: Record<string, string> = { light: 'Light', dark: 'Dark', system: 'System' };

function text(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function providerName(value: unknown): string {
  const id = text(value);
  return id ? (PROVIDERS[id] ?? id) : 'an account';
}

function signInMethod(method: unknown): string {
  switch (method) {
    case 'password':
      return 'Signed in with a password';
    case 'email_verification':
      return 'Signed in by verifying your email';
    case 'google':
    case 'github':
      return `Signed in with ${providerName(method)}`;
    default:
      return 'Signed in';
  }
}

/** "Changed your display name to “Ada King” and your theme to Dark". */
function profileChanges(changes: ActivityEntry['changes']): string {
  const parts: string[] = [];
  for (const [field, change] of Object.entries(changes)) {
    const to = text(change.to);
    if (field === 'name' && to) parts.push(`your display name to “${to}”`);
    else if (field === 'username' && to) parts.push(`your username to @${to}`);
    else if (field === 'displayUsername' && to) parts.push(`how your username is written to ${to}`);
    else if (field === 'theme' && to) parts.push(`your theme to ${THEME_LABELS[to] ?? to}`);
  }
  if (parts.length === 0) return 'Updated your profile';
  const last = parts.pop() ?? '';
  return `Changed ${parts.length > 0 ? `${parts.join(', ')} and ${last}` : last}`;
}

const AGENT_NOTIFICATION_LABELS: Record<string, string> = {
  all: 'everything',
  needs_me: 'only what needs you',
  none: 'nothing',
};

/** "Paused your agent", "Changed agent notifications to only what needs you", or both. */
function agentSettingsChanges(changes: ActivityEntry['changes']): string {
  const parts: string[] = [];
  const paused = changes.agentPaused;
  if (paused && paused.to === true) parts.push('Paused your agent');
  else if (paused && paused.to === false) parts.push('Resumed your agent');
  const level = changes.agentNotifications;
  if (level) {
    const to = text(level.to);
    const label = to ? AGENT_NOTIFICATION_LABELS[to] : undefined;
    const sentence = label
      ? `changed agent notifications to ${label}`
      : 'changed agent notifications';
    parts.push(parts.length > 0 ? sentence : sentence[0]!.toUpperCase() + sentence.slice(1));
  }
  return parts.length > 0 ? parts.join(' and ') : 'Changed your agent’s settings';
}

function revokedSuffix(meta: Record<string, unknown>): string {
  const revoked = count(meta.revokedSessions);
  return revoked > 0 ? ` and signed out ${pluralize(revoked, 'other session')}` : '';
}

/** Where it came from: browser and IP (sign-ins), the device signed out, the API key used. */
function context(entry: ActivityEntry): string[] {
  const { meta } = entry;
  const details: string[] = [];
  const agent = text(meta.userAgent);
  if (agent) details.push(describeUserAgent(agent));
  const ip = text(meta.ip);
  if (ip) details.push(ip);
  const { user, via } = entry.actor;
  // An agent member acting through a key (agents A): "by Ada AI via Claude on laptop".
  if (via) details.push(`${isAgentUser(user) ? `by ${user.name} ` : ''}via ${via.keyName}`);
  else if (entry.actor.source === 'mcp' || entry.actor.source === 'api') {
    details.push(entry.actor.source === 'mcp' ? 'via MCP' : 'via the API');
  }
  return details;
}

export function describeSecurityEvent(entry: ActivityEntry): SecurityEventText {
  const { meta } = entry;
  const details = context(entry);
  const keyName = text(meta.name);
  switch (entry.action) {
    case 'user.signed_up':
      return {
        kind: 'account',
        title:
          text(meta.method) && meta.method !== 'email'
            ? `Created your account with ${providerName(meta.method)}`
            : 'Created your account',
        details,
      };
    case 'user.signed_in':
      return { kind: 'sign-in', title: signInMethod(meta.method), details };
    case 'user.password_changed':
      return { kind: 'password', title: `Changed your password${revokedSuffix(meta)}`, details };
    case 'user.password_set':
      return { kind: 'password', title: `Set a password${revokedSuffix(meta)}`, details };
    case 'user.password_reset':
      return { kind: 'password', title: 'Reset your password with an emailed code', details };
    case 'user.account_linked':
      return { kind: 'connection', title: `Connected ${providerName(meta.provider)}`, details };
    case 'user.account_unlinked':
      return { kind: 'connection', title: `Disconnected ${providerName(meta.provider)}`, details };
    case 'api_key.created':
      return {
        kind: 'api-key',
        title: keyName ? `Created API key “${keyName}”` : 'Created an API key',
        details,
      };
    case 'api_key.revoked':
      return {
        kind: 'api-key',
        title: keyName ? `Revoked API key “${keyName}”` : 'Revoked an API key',
        details,
      };
    case 'user.session_revoked': {
      const browser = text(meta.browser);
      const os = text(meta.os);
      const device = browser && os ? `${browser} on ${os}` : (browser ?? os);
      return {
        kind: 'session',
        title: device ? `Signed out a session (${device})` : 'Signed out a session',
        details,
      };
    }
    case 'user.sessions_revoked':
      return {
        kind: 'session',
        title: `Signed out ${pluralize(count(meta.count), 'other session')}`,
        details,
      };
    case 'user.profile_updated':
      return { kind: 'profile', title: profileChanges(entry.changes), details };
    case 'user.avatar_changed':
      return { kind: 'profile', title: 'Changed your profile picture', details };
    case 'user.avatar_removed':
      return { kind: 'profile', title: 'Removed your profile picture', details };
    case 'user.agent_settings_changed':
      return { kind: 'agent', title: agentSettingsChanges(entry.changes), details };
    default:
      return { kind: 'account', title: entry.action, details };
  }
}
