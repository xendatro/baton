import type { ActivityEntityType } from '@shared/constants';
import type { ActivityEntry, FieldChange } from '@shared/schemas/core';

/**
 * Plain-language wording of audit entries, shared by item timelines ("moved from Open to Done")
 * and the team audit log ("moved API-12 from Open to Done", "changed permissions of Admin:
 * +MANAGE_ROLES"). Values arrive human-readable from the server (status names, usernames).
 *
 * The entity is named from the entry's `meta` snapshot: `ref` and `title` for tasks and issues,
 * `parentRef` for replies, `filename` for attachments, `username` for members, `code` for invites
 * and `name` (or `title`, `key`) for everything else.
 */

export interface ActivityPart {
  text: string;
  /** Names and values are emphasised. */
  emphasis?: boolean;
  /** The entity the entry is about (links to `entry.url` where one exists). */
  entity?: boolean;
  /** Monospace (refs, permission names). */
  code?: boolean;
  /** List deltas written as `+X` / `−X`. */
  tone?: 'added' | 'removed';
}

/**
 * `this`: the entry is shown on the entity's own page ("created this task", "moved from Open to
 * Done"). `entity`: the entry is shown in a feed and names its entity ("created task API-12").
 */
export type ActivitySubject = 'this' | 'entity';

export interface DescribeOptions {
  subject?: ActivitySubject;
}

const FIELD_LABELS: Record<string, string> = {
  dueDate: 'due date',
  statusId: 'status',
  assignees: 'assignees',
  assigneeUsers: 'assignees',
  assigneeRoles: 'role assignees',
  labels: 'labels',
  description: 'description',
  body: 'description',
  readme: 'README',
  permissions: 'permissions',
  mentionable: 'mentionable',
  maxUses: 'max uses',
  expiresAt: 'expiry',
  isDefault: 'default',
  blockedBy: 'blockers',
  links: 'linked issues',
};

/** Long text fields: the change is summarised instead of printed. */
const TEXT_FIELDS = new Set(['description', 'body', 'readme']);
/** Fields whose change renames the entity. */
const NAME_FIELDS = new Set(['title', 'name']);
/** List fields written as `+X −Y` tokens (identifiers rather than names). */
const TOKEN_FIELDS = new Set(['permissions']);

const ENTITY_NOUNS: Record<ActivityEntityType, string> = {
  user: 'account',
  api_key: 'API key',
  team: 'team',
  member: 'member',
  role: 'role',
  invite: 'invite link',
  project: 'project',
  status: 'status',
  label: 'label',
  issue: 'issue',
  task: 'task',
  reply: 'reply',
  attachment: 'file',
};

/** Verbs of actions that carry no field changes worth listing. */
const LIFECYCLE = new Set(['created', 'deleted', 'restored', 'purged']);

export function entityNoun(entityType: ActivityEntityType): string {
  return ENTITY_NOUNS[entityType];
}

export function fieldLabel(field: string): string {
  return (
    FIELD_LABELS[field] ??
    field
      .replace(/([a-z])([A-Z])/g, '$1 $2')
      .replace(/_/g, ' ')
      .toLowerCase()
  );
}

export function formatValue(value: unknown): string {
  if (value === null || value === undefined || value === '') return 'none';
  if (typeof value === 'boolean') return value ? 'yes' : 'no';
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  if (Array.isArray(value)) return value.map(formatValue).join(', ') || 'none';
  if (typeof value === 'object' && 'name' in value) return formatValue(value.name);
  return JSON.stringify(value);
}

function isEmpty(value: unknown): boolean {
  return (
    value === null ||
    value === undefined ||
    value === '' ||
    (Array.isArray(value) && value.length === 0)
  );
}

/** Items added to and removed from a list field. */
export function listDelta(change: FieldChange): { added: string[]; removed: string[] } {
  const before = (Array.isArray(change.from) ? change.from : []).map(formatValue);
  const after = (Array.isArray(change.to) ? change.to : []).map(formatValue);
  return {
    added: after.filter((item) => !before.includes(item)),
    removed: before.filter((item) => !after.includes(item)),
  };
}

function isListChange(change: FieldChange): boolean {
  return Array.isArray(change.from) || Array.isArray(change.to);
}

// ---------------------------------------------------------------------------------------------
// Naming the entity
// ---------------------------------------------------------------------------------------------

function metaString(entry: ActivityEntry, key: string): string | null {
  const value = entry.meta[key];
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

/** The entity's short name from the meta snapshot (`API-12`, `Admin`, `@bob`), if recorded. */
export function entityName(entry: ActivityEntry): string | null {
  switch (entry.entityType) {
    case 'task':
    case 'issue':
      return metaString(entry, 'ref') ?? metaString(entry, 'title');
    case 'reply':
      return metaString(entry, 'parentRef');
    case 'attachment':
      return metaString(entry, 'filename') ?? metaString(entry, 'name');
    case 'member': {
      const username = metaString(entry, 'username');
      return username ? `@${username.replace(/^@/, '')}` : metaString(entry, 'name');
    }
    case 'invite':
      return metaString(entry, 'code');
    default:
      return metaString(entry, 'name') ?? metaString(entry, 'title') ?? metaString(entry, 'key');
  }
}

/**
 * How a feed names the entity: "task API-12", "role Admin", "a reply on API-12", "the team".
 * `withNoun` adds the type word; `withTitle` adds a task's or issue's title in quotes.
 */
function entityPhrase(
  entry: ActivityEntry,
  { withNoun, withTitle }: { withNoun: boolean; withTitle: boolean },
): ActivityPart[] {
  const noun = entityNoun(entry.entityType);
  const name = entityName(entry);
  switch (entry.entityType) {
    case 'team':
      return [{ text: 'the team', entity: true }];
    case 'user':
      return [{ text: 'their account' }];
    case 'reply':
      return name
        ? [{ text: 'a reply on' }, { text: name, entity: true, code: true }]
        : [{ text: 'a reply', entity: true }];
    case 'invite':
      return name
        ? [{ text: 'invite link' }, { text: name, entity: true, code: true }]
        : [{ text: 'an invite link', entity: true }];
    default:
      break;
  }
  if (!name) return [{ text: `a ${noun}`, entity: true }];
  const isItem = entry.entityType === 'task' || entry.entityType === 'issue';
  const hasRef = isItem && metaString(entry, 'ref') !== null;
  const parts: ActivityPart[] = [];
  if (withNoun && entry.entityType !== 'member') parts.push({ text: noun });
  parts.push({ text: name, entity: true, ...(hasRef ? { code: true } : { emphasis: true }) });
  const title = hasRef ? metaString(entry, 'title') : null;
  if (withTitle && title) parts.push({ text: `“${title}”` });
  return parts;
}

// ---------------------------------------------------------------------------------------------
// Field changes
// ---------------------------------------------------------------------------------------------

/**
 * Phrases for one field change. `object` names the entity in a feed ("of API-12", "to API-12");
 * leave it out on the entity's own page.
 */
export function describeChange(
  field: string,
  change: FieldChange,
  object: ActivityPart[] = [],
  entityType?: ActivityEntityType,
): ActivityPart[] {
  const label = fieldLabel(field);
  const { from, to } = change;
  const of = object.length ? [{ text: 'of' }, ...object] : [];
  if (TEXT_FIELDS.has(field)) return [{ text: `edited the ${label}` }, ...of];

  if (isListChange(change)) {
    const { added, removed } = listDelta(change);
    if (TOKEN_FIELDS.has(field)) {
      if (!added.length && !removed.length) return [{ text: `changed ${label}` }, ...of];
      return [
        { text: `changed ${label}` },
        ...of,
        { text: ':' },
        ...added.map((item): ActivityPart => ({ text: `+${item}`, code: true, tone: 'added' })),
        ...removed.map((item): ActivityPart => ({ text: `−${item}`, code: true, tone: 'removed' })),
      ];
    }
    const parts: ActivityPart[] = [];
    if (added.length) {
      parts.push({ text: `added ${label}` }, { text: added.join(', '), emphasis: true });
      if (object.length) parts.push({ text: 'to' }, ...object);
    }
    if (removed.length) {
      if (parts.length) parts.push({ text: 'and' });
      parts.push({ text: `removed ${label}` }, { text: removed.join(', '), emphasis: true });
      if (object.length && !added.length) parts.push({ text: 'from' }, ...object);
    }
    return parts.length ? parts : [{ text: `changed ${label}` }, ...of];
  }

  if (entityType === 'task' && (field === 'status' || field === 'statusId') && !isEmpty(from)) {
    return [
      { text: 'moved' },
      ...object,
      { text: 'from' },
      { text: formatValue(from), emphasis: true },
      { text: 'to' },
      { text: formatValue(to), emphasis: true },
    ];
  }
  if (NAME_FIELDS.has(field) && !isEmpty(from) && !isEmpty(to)) {
    return [
      { text: 'renamed' },
      ...object,
      { text: 'from' },
      { text: `“${formatValue(from)}”`, emphasis: true },
      { text: 'to' },
      { text: `“${formatValue(to)}”`, emphasis: true },
    ];
  }
  if (isEmpty(to)) return [{ text: `cleared the ${label}` }, ...of];
  if (isEmpty(from)) {
    return [
      { text: `set ${label}` },
      ...of,
      { text: 'to' },
      { text: formatValue(to), emphasis: true },
    ];
  }
  return [
    { text: `changed ${label}` },
    ...of,
    { text: 'from' },
    { text: formatValue(from), emphasis: true },
    { text: 'to' },
    { text: formatValue(to), emphasis: true },
  ];
}

// ---------------------------------------------------------------------------------------------
// Whole entries
// ---------------------------------------------------------------------------------------------

/** The action's verb: `task.claim_expired` → `claim_expired`. */
function verbOf(action: string): string {
  return action.split('.').slice(1).join('.') || action;
}

function words(verb: string): string {
  return verb.replace(/[._]/g, ' ');
}

/** Lifecycle wording on the entity's own page ("created this task"). */
const THIS_VERBS: Record<string, string> = {
  created: 'created this',
  deleted: 'deleted this',
  restored: 'restored this',
  purged: 'permanently deleted this',
  resolved: 'resolved this',
  reopened: 'reopened this',
  claimed: 'claimed this task',
  released: 'released the claim',
  claim_expired: 'expired the claim',
  claim_taken_over: 'took over the claim',
  claim_renewed: 'renewed the claim',
  renewed: 'renewed the claim',
  moved: 'moved this',
  edited: 'edited this',
};

/** Feed wording: the verb before the entity phrase (`resolved issue API#4`). */
const FEED_VERBS: Record<string, string> = {
  created: 'created',
  deleted: 'deleted',
  restored: 'restored',
  purged: 'permanently deleted',
  resolved: 'resolved',
  reopened: 'reopened',
  claimed: 'claimed',
  released: 'released the claim on',
  claim_expired: 'expired the claim on',
  claim_taken_over: 'took over the claim on',
  claim_renewed: 'renewed the claim on',
  renewed: 'renewed the claim on',
  moved: 'moved',
  edited: 'edited',
  revoked: 'revoked',
  uploaded: 'uploaded',
  updated: 'updated',
};

/** Actions whose feed wording doesn't follow "<verb> <entity>". */
function specialFeedSentence(entry: ActivityEntry, verb: string): ActivityPart[] | null {
  const phrase = () => entityPhrase(entry, { withNoun: false, withTitle: false });
  switch (`${entry.entityType}.${verb}`) {
    case 'reply.created': {
      const parent = entityName(entry);
      return parent
        ? [{ text: 'replied on' }, { text: parent, entity: true, code: true }]
        : [{ text: 'replied', entity: true }];
    }
    case 'member.joined':
      return [{ text: 'joined the team' }];
    case 'member.left':
      return [{ text: 'left the team' }];
    case 'member.removed':
      return [{ text: 'removed' }, ...phrase(), { text: 'from the team' }];
    case 'team.created':
      return [{ text: 'created the team' }];
    case 'team.deleted':
      return [{ text: 'deleted the team' }];
    case 'team.restored':
      return [{ text: 'restored the team' }];
    case 'invite.created':
      return [{ text: 'created' }, ...entityPhrase(entry, { withNoun: true, withTitle: false })];
    default:
      return null;
  }
}

function joinChanges(
  changes: Array<[string, FieldChange]>,
  object: ActivityPart[],
  entityType: ActivityEntityType,
): ActivityPart[] {
  const parts: ActivityPart[] = [];
  changes.forEach(([field, change], index) => {
    if (index > 0) parts.push({ text: index === changes.length - 1 ? 'and' : ',' });
    // The first phrase names the entity; the rest are understood to be about it.
    parts.push(...describeChange(field, change, index === 0 ? object : [], entityType));
  });
  return parts;
}

/** The sentence after the actor's name, as parts to render. */
export function describeActivity(
  entry: ActivityEntry,
  options: DescribeOptions = {},
): ActivityPart[] {
  const subject = options.subject ?? 'this';
  const verb = verbOf(entry.action);
  const changes = Object.entries(entry.changes);

  if (subject === 'this') {
    if (changes.length > 0 && !LIFECYCLE.has(verb)) {
      return joinChanges(changes, [], entry.entityType);
    }
    const known = THIS_VERBS[verb];
    if (known) {
      return [
        { text: known.endsWith(' this') ? `${known} ${entityNoun(entry.entityType)}` : known },
      ];
    }
    return [{ text: words(verb) }];
  }

  const special = specialFeedSentence(entry, verb);
  if (special) return special;
  if (changes.length > 0 && !LIFECYCLE.has(verb)) {
    return joinChanges(
      changes,
      entityPhrase(entry, { withNoun: false, withTitle: false }),
      entry.entityType,
    );
  }
  const lifecycle = LIFECYCLE.has(verb) || verb === 'uploaded';
  const phrase = entityPhrase(entry, { withNoun: true, withTitle: lifecycle });
  const known = FEED_VERBS[verb];
  if (known) return [{ text: known }, ...phrase];
  return [{ text: words(verb) }, { text: ':' }, ...phrase];
}

/** Whether a part is written without a space before it (punctuation). */
export function hugsPrevious(part: ActivityPart): boolean {
  return part.text === ',' || part.text === ':';
}

/** The sentence as plain text ("moved API-12 from Open to Done"), e.g. for exports. */
export function activitySentence(entry: ActivityEntry, options: DescribeOptions = {}): string {
  return describeActivity(entry, options).reduce(
    (text, part, index) => (index === 0 || hugsPrevious(part) ? text : `${text} `) + part.text,
    '',
  );
}

// ---------------------------------------------------------------------------------------------
// Field diffs (expanded audit rows)
// ---------------------------------------------------------------------------------------------

export type DiffRow =
  | { field: string; label: string; kind: 'value'; from: string; to: string }
  | { field: string; label: string; kind: 'text'; from: string; to: string }
  | { field: string; label: string; kind: 'list'; added: string[]; removed: string[] };

/** Every field change of an entry, ready to show as `from → to`. */
export function diffRows(entry: ActivityEntry): DiffRow[] {
  return Object.entries(entry.changes).map(([field, change]): DiffRow => {
    const label = fieldLabel(field);
    if (isListChange(change)) return { field, label, kind: 'list', ...listDelta(change) };
    const kind = TEXT_FIELDS.has(field) ? 'text' : 'value';
    return { field, label, kind, from: formatValue(change.from), to: formatValue(change.to) };
  });
}
