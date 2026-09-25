import type { ActivityEntry, FieldChange } from '@shared/schemas/core';

/**
 * Plain-language summaries of audit entries for timelines: "changed status from Open to Done",
 * "added label Bug", "claimed this task". Values arrive human-readable from the server.
 */

export interface ActivityPart {
  text: string;
  /** Values (names, dates) are emphasised. */
  emphasis?: boolean;
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

const VERBS: Record<string, string> = {
  created: 'created this',
  deleted: 'deleted this',
  restored: 'restored this',
  resolved: 'resolved this',
  reopened: 'reopened this',
  claimed: 'claimed this task',
  released: 'released the claim',
  claim_expired: 'expired the claim',
  claim_taken_over: 'took over the claim',
  renewed: 'renewed the claim',
  moved: 'moved this',
};

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

/** Phrases for one field change. Arrays become "added …" / "removed …". */
export function describeChange(field: string, change: FieldChange): ActivityPart[] {
  const label = fieldLabel(field);
  const { from, to } = change;
  if (TEXT_FIELDS.has(field)) return [{ text: `edited the ${label}` }];
  if (Array.isArray(from) || Array.isArray(to)) {
    const before = (Array.isArray(from) ? from : []).map(formatValue);
    const after = (Array.isArray(to) ? to : []).map(formatValue);
    const added = after.filter((item) => !before.includes(item));
    const removed = before.filter((item) => !after.includes(item));
    const parts: ActivityPart[] = [];
    if (added.length)
      parts.push({ text: `added ${label}` }, { text: added.join(', '), emphasis: true });
    if (removed.length) {
      if (parts.length) parts.push({ text: 'and' });
      parts.push({ text: `removed ${label}` }, { text: removed.join(', '), emphasis: true });
    }
    return parts.length ? parts : [{ text: `changed ${label}` }];
  }
  if (isEmpty(to)) return [{ text: `cleared the ${label}` }];
  if (isEmpty(from)) {
    return [{ text: `set ${label} to` }, { text: formatValue(to), emphasis: true }];
  }
  return [
    { text: `changed ${label} from` },
    { text: formatValue(from), emphasis: true },
    { text: 'to' },
    { text: formatValue(to), emphasis: true },
  ];
}

export function describeActivity(entry: ActivityEntry): ActivityPart[] {
  const verb = entry.action.split('.').slice(1).join('.') || entry.action;
  const entity = entry.entityType.replace(/_/g, ' ');
  const changes = Object.entries(entry.changes);
  if (changes.length > 0 && !['created', 'deleted', 'restored'].includes(verb)) {
    const parts: ActivityPart[] = [];
    changes.forEach(([field, change], index) => {
      if (index > 0) parts.push({ text: index === changes.length - 1 ? 'and' : ',' });
      parts.push(...describeChange(field, change));
    });
    return parts;
  }
  const known = VERBS[verb];
  if (known) {
    return [{ text: known.endsWith(' this') ? `${known} ${entity}` : known }];
  }
  return [{ text: verb.replace(/[._]/g, ' ') }];
}
