import type { JSONContent, MarkdownToken } from '@tiptap/core';
import Mention from '@tiptap/extension-mention';
import { UsersIcon } from 'lucide-react';
import type { RoleSummary, UserSummary } from '@shared/schemas/core';
import { AgentBadge } from '@web/components/common/AgentBadge';
import { UserAvatar } from '@web/components/common/UserAvatar';
import { isAgentUser } from '@web/lib/agentMembers';
import {
  EVERYONE_SLUG,
  formatMention,
  mentionAtStart,
  nextMentionStart,
  type MentionKind,
} from '@web/lib/mentions';
import type { SuggestionItem } from './SuggestionMenu';
import { suggestionRenderer } from './suggestionRenderer';

/**
 * `@` mentions of people (and agent members), roles and everyone. In markdown they are
 * `@username` (`@ethan-ai` for an agent), `@&role-slug` and `@everyone` (web/lib/mentions.ts); in
 * the editor they are atomic chips.
 */

/**
 * An agent member that took part in a thread (BAT-12, agents A), offered first as `@ethan-ai`.
 */
export interface MentionAgent {
  /** The agent member ("Ethan AI", `ethan-ai`). */
  user: UserSummary;
  /** The harness of its latest write in the thread ("Claude"), for the logo; null: generic. */
  agentName: string | null;
}

export interface MentionItem extends SuggestionItem {
  kind: MentionKind;
  /** Username or role slug. */
  id: string;
  label: string;
  user?: UserSummary;
  role?: RoleSummary;
  agent?: MentionAgent;
}

/** Loads mention candidates for a query (the team's mentionables). */
export type MentionSource = (query: string, signal: AbortSignal) => Promise<MentionItem[]>;

export function toMentionItems(users: readonly UserSummary[], roles: readonly RoleSummary[]) {
  return [
    ...users.map((user): MentionItem => ({
      key: `user:${user.id}`,
      group: 'People',
      kind: 'user',
      id: user.username,
      label: user.username,
      user,
    })),
    ...roles.map((role): MentionItem => ({
      key: `role:${role.id}`,
      group: 'Roles',
      kind: 'role',
      id: role.slug,
      label: role.slug === EVERYONE_SLUG ? EVERYONE_SLUG : role.name,
      role,
    })),
  ];
}

/** The thread's agent members whose name or username contains `query`, as user mentions. */
export function toAgentMentionItems(agents: readonly MentionAgent[], query: string) {
  const q = query.trim().toLowerCase();
  return agents
    .filter(
      ({ user }) => user.username.toLowerCase().includes(q) || user.name.toLowerCase().includes(q),
    )
    .map((agent): MentionItem => ({
      key: `agent:${agent.user.id}`,
      group: 'Agents',
      kind: 'user',
      id: agent.user.username,
      label: agent.user.username,
      user: agent.user,
      agent,
    }));
}

interface MentionToken extends MarkdownToken {
  kind: MentionKind;
  id: string;
}

function isMentionToken(token: MarkdownToken): token is MentionToken {
  return typeof token.id === 'string' && (token.kind === 'user' || token.kind === 'role');
}

/** Name characters just before a candidate `@` mean it is part of a word or email, not a mention. */
function followsNameCharacter(tokens: MarkdownToken[]): boolean {
  const previous = tokens.at(-1);
  return typeof previous?.raw === 'string' && /[\w@&./]$/.test(previous.raw);
}

export function mentionText(attrs: Record<string, unknown>): string {
  const kind = attrs.kind === 'role' ? 'role' : 'user';
  const id = typeof attrs.id === 'string' ? attrs.id : '';
  const label = typeof attrs.label === 'string' && attrs.label ? attrs.label : id;
  return kind === 'role' && id !== EVERYONE_SLUG ? `@${label}` : `@${id}`;
}

const BatonMention = Mention.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      kind: {
        default: 'user',
        parseHTML: (element) => (element.getAttribute('data-kind') === 'role' ? 'role' : 'user'),
        renderHTML: (attributes) => ({ 'data-kind': attributes.kind as string }),
      },
    };
  },

  renderText({ node }) {
    return formatMention(node.attrs.kind as MentionKind, node.attrs.id as string);
  },

  markdownTokenName: 'mention',
  markdownTokenizer: {
    name: 'mention',
    level: 'inline',
    start: (src: string) => nextMentionStart(src),
    tokenize: (src: string, tokens: MarkdownToken[]) => {
      if (followsNameCharacter(tokens)) return undefined;
      const mention = mentionAtStart(src);
      if (!mention) return undefined;
      return { type: 'mention', raw: mention.raw, kind: mention.kind, id: mention.id };
    },
  },
  parseMarkdown: (token: MarkdownToken): JSONContent => {
    if (!isMentionToken(token)) return { type: 'text', text: token.raw ?? '' };
    return { type: 'mention', attrs: { id: token.id, label: token.id, kind: token.kind } };
  },
  renderMarkdown: (node: JSONContent) =>
    formatMention(node.attrs?.kind === 'role' ? 'role' : 'user', String(node.attrs?.id ?? '')),
});

/** Mention extension wired to a candidate source (none: mentions still parse and render). */
export function createMention(source: MentionSource | null) {
  return BatonMention.configure({
    HTMLAttributes: { class: 'mention' },
    renderHTML({ options, node }) {
      return ['span', options.HTMLAttributes, mentionText(node.attrs)];
    },
    suggestion: {
      char: '@',
      allowSpaces: false,
      debounce: 150,
      items: async ({ query, signal }: { query: string; signal: AbortSignal }) => {
        if (!source) return [];
        const roleOnly = query.startsWith('&');
        const items = await source(roleOnly ? query.slice(1) : query, signal);
        return (roleOnly ? items.filter((item) => item.kind === 'role') : items).slice(0, 12);
      },
      command: ({ editor, range, props }) => {
        const item = props as MentionItem;
        editor
          .chain()
          .focus()
          .insertContentAt(range, [
            { type: 'mention', attrs: { id: item.id, label: item.label, kind: item.kind } },
            { type: 'text', text: ' ' },
          ])
          .run();
      },
      render: suggestionRenderer<MentionItem>({
        label: 'Mention someone',
        emptyText: source ? 'No one matches.' : 'Mentions are unavailable here.',
        renderItem: (item) =>
          item.user ? (
            <>
              <UserAvatar user={item.user} agentName={item.agent?.agentName} size="sm" />
              <span className="truncate">{item.user.name}</span>
              {isAgentUser(item.user) ? <AgentBadge /> : null}
              <span className="ml-auto truncate text-xs text-muted-foreground">
                @{item.user.username}
              </span>
            </>
          ) : (
            <>
              <span
                className="flex size-5 items-center justify-center rounded-full"
                style={{ color: item.role?.color ?? undefined }}
              >
                <UsersIcon className="size-3.5" aria-hidden="true" />
              </span>
              <span className="truncate">
                {item.id === EVERYONE_SLUG ? '@everyone' : item.label}
              </span>
              <span className="ml-auto text-xs text-muted-foreground">role</span>
            </>
          ),
      }),
    },
  });
}
