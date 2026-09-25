import { describe, expect, it } from 'vitest';
import type { ActivityEntry } from '@shared/schemas/core';
import { claudeCodeCommand, codexConfig, codexExport, curlExample, mcpUrl } from './agentSetup';
import { describeSecurityEvent } from './securityLog';

function entry(
  action: string,
  meta: Record<string, unknown> = {},
  overrides: Partial<ActivityEntry> = {},
): ActivityEntry {
  return {
    id: 'a1',
    teamId: null,
    projectId: null,
    actor: {
      user: { id: 'u1', username: 'ada', name: 'Ada', image: null },
      via: null,
      source: 'web',
    },
    entityType: 'user',
    entityId: 'u1',
    action,
    changes: {},
    meta,
    url: '/settings/security',
    createdAt: '2026-09-25T10:00:00.000Z',
    ...overrides,
  };
}

const CHROME_MAC =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

describe('describeSecurityEvent', () => {
  it('describes sign-ins with the method, browser and address', () => {
    expect(
      describeSecurityEvent(
        entry('user.signed_in', { method: 'password', ip: '203.0.113.7', userAgent: CHROME_MAC }),
      ),
    ).toEqual({
      kind: 'sign-in',
      title: 'Signed in with a password',
      details: ['Chrome on macOS', '203.0.113.7'],
    });
    expect(describeSecurityEvent(entry('user.signed_in', { method: 'github' })).title).toBe(
      'Signed in with GitHub',
    );
    expect(
      describeSecurityEvent(entry('user.signed_in', { method: 'email_verification' })).title,
    ).toBe('Signed in by verifying your email');
  });

  it('describes password, connection, key and session events', () => {
    const cases: Array<[ActivityEntry, string]> = [
      [entry('user.signed_up', { method: 'google' }), 'Created your account with Google'],
      [entry('user.signed_up', { method: 'email' }), 'Created your account'],
      [entry('user.password_changed', { revokedSessions: 0 }), 'Changed your password'],
      [
        entry('user.password_changed', { revokedSessions: 2 }),
        'Changed your password and signed out 2 other sessions',
      ],
      [
        entry('user.password_set', { revokedSessions: 1 }),
        'Set a password and signed out 1 other session',
      ],
      [entry('user.password_reset'), 'Reset your password with an emailed code'],
      [entry('user.account_linked', { provider: 'github' }), 'Connected GitHub'],
      [entry('user.account_unlinked', { provider: 'google' }), 'Disconnected Google'],
      [entry('user.account_unlinked', { provider: null }), 'Disconnected an account'],
      [
        entry('api_key.created', { name: 'Claude on laptop' }),
        'Created API key “Claude on laptop”',
      ],
      [entry('api_key.revoked', { name: 'Old' }), 'Revoked API key “Old”'],
      [
        entry('user.session_revoked', { browser: 'Safari', os: 'iOS' }),
        'Signed out a session (Safari on iOS)',
      ],
      [entry('user.sessions_revoked', { count: 3 }), 'Signed out 3 other sessions'],
      [entry('user.avatar_changed'), 'Changed your profile picture'],
      [entry('user.avatar_removed'), 'Removed your profile picture'],
      [entry('user.something_new'), 'user.something_new'],
    ];
    for (const [input, title] of cases) {
      expect(describeSecurityEvent(input).title, input.action).toBe(title);
    }
  });

  it('lists every profile change in one sentence', () => {
    const changes = {
      name: { from: 'Ada', to: 'Ada King' },
      username: { from: 'ada', to: 'ada_k' },
      theme: { from: 'system', to: 'dark' },
    };
    expect(describeSecurityEvent(entry('user.profile_updated', {}, { changes })).title).toBe(
      'Changed your display name to “Ada King”, your username to @ada_k and your theme to Dark',
    );
  });

  it('says which API key or channel made the change', () => {
    const viaKey = entry(
      'user.profile_updated',
      {},
      {
        changes: { theme: { from: 'dark', to: 'light' } },
        actor: {
          user: null,
          via: { keyId: 'k1', keyName: 'Claude on laptop' },
          source: 'mcp',
        },
      },
    );
    expect(describeSecurityEvent(viaKey).details).toEqual(['via Claude on laptop']);
  });
});

describe('agent setup snippets', () => {
  it('builds ready-to-paste commands for the real origin', () => {
    const origin = 'https://baton.example.com/';
    expect(mcpUrl(origin)).toBe('https://baton.example.com/mcp');
    expect(claudeCodeCommand(origin, 'bat_123')).toBe(
      'claude mcp add --transport http baton https://baton.example.com/mcp --header "Authorization: Bearer bat_123"',
    );
    expect(codexConfig(origin)).toBe(
      [
        '# ~/.codex/config.toml',
        '[mcp_servers.baton]',
        'url = "https://baton.example.com/mcp"',
        'bearer_token_env_var = "BATON_API_KEY"',
      ].join('\n'),
    );
    expect(codexExport('bat_123')).toBe('export BATON_API_KEY="bat_123"');
    expect(curlExample(origin, 'bat_123')).toBe(
      'curl -H "Authorization: Bearer bat_123" https://baton.example.com/api/me',
    );
  });
});
