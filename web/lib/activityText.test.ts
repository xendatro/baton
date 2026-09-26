import { describe, expect, it } from 'vitest';
import type { ActivityEntry } from '@shared/schemas/core';
import { activitySentence, describeChange, diffRows, entityName } from './activityText';

function entry(overrides: Partial<ActivityEntry>): ActivityEntry {
  return {
    id: 'a1',
    teamId: 't1',
    projectId: 'p1',
    actor: { user: null, via: null, source: 'web' },
    entityType: 'task',
    entityId: 'task1',
    action: 'task.updated',
    changes: {},
    meta: { ref: 'API-12', title: 'Fix login' },
    url: '/t/acme/p/API/tasks/12',
    createdAt: '2026-09-24T10:00:00.000Z',
    ...overrides,
  };
}

const onPage = (value: ActivityEntry) => activitySentence(value, { subject: 'this' });
const inFeed = (value: ActivityEntry) => activitySentence(value, { subject: 'entity' });

describe('activity wording on the entity’s own page', () => {
  it('describes field changes with human values', () => {
    const moved = entry({
      action: 'task.status_changed',
      changes: { status: { from: 'Open', to: 'Done' } },
    });
    expect(onPage(moved)).toBe('moved from Open to Done');
    const text = (field: string, from: unknown, to: unknown) =>
      describeChange(field, { from, to })
        .map((part) => part.text)
        .join(' ');
    expect(text('dueDate', null, '2026-10-01')).toBe('set due date to 2026-10-01');
    expect(text('dueDate', '2026-10-01', null)).toBe('cleared the due date');
    expect(text('description', 'a', 'b')).toBe('edited the description');
    expect(text('priority', 'Low', 'High')).toBe('changed priority from Low to High');
    expect(text('title', 'Old', 'New')).toBe('renamed from “Old” to “New”');
  });

  it('describes list changes as additions and removals', () => {
    expect(onPage(entry({ changes: { labels: { from: ['Bug'], to: ['Docs', 'Feature'] } } }))).toBe(
      'added labels Docs, Feature and removed label Bug',
    );
  });

  it('uses verbs for lifecycle actions', () => {
    expect(onPage(entry({ action: 'task.created' }))).toBe('created this task');
    expect(onPage(entry({ action: 'task.claimed' }))).toBe('claimed this task');
    expect(onPage(entry({ action: 'issue.resolved', entityType: 'issue' }))).toBe(
      'resolved this issue',
    );
    expect(onPage(entry({ action: 'task.link_added' }))).toBe('link added');
  });

  it('joins several changes', () => {
    expect(
      onPage(
        entry({
          changes: {
            priority: { from: 'Low', to: 'High' },
            dueDate: { from: null, to: '2026-10-01' },
            labels: { from: [], to: ['Bug'] },
          },
        }),
      ),
    ).toBe('changed priority from Low to High, set due date to 2026-10-01 and added label Bug');
  });
});

describe('activity wording in the audit log', () => {
  it('names the entity in the first phrase', () => {
    expect(
      inFeed(
        entry({ action: 'task.status_changed', changes: { status: { from: 'Open', to: 'Done' } } }),
      ),
    ).toBe('moved API-12 from Open to Done');
    expect(
      inFeed(
        entry({
          changes: {
            priority: { from: 'Low', to: 'High' },
            dueDate: { from: null, to: '2026-10-01' },
          },
        }),
      ),
    ).toBe('changed priority of API-12 from Low to High and set due date to 2026-10-01');
    expect(inFeed(entry({ changes: { labels: { from: [], to: ['Bug'] } } }))).toBe(
      'added label Bug to API-12',
    );
    expect(inFeed(entry({ changes: { labels: { from: ['Bug'], to: [] } } }))).toBe(
      'removed label Bug from API-12',
    );
  });

  it('writes permission changes as tokens', () => {
    const role = entry({
      entityType: 'role',
      action: 'role.permissions_changed',
      meta: { name: 'Admin' },
      changes: {
        permissions: { from: ['CREATE_INVITES'], to: ['MANAGE_ROLES', 'MANAGE_MEMBERS'] },
      },
    });
    expect(inFeed(role)).toBe(
      'changed permissions of Admin: +MANAGE_ROLES +MANAGE_MEMBERS −CREATE_INVITES',
    );
  });

  it('describes lifecycle actions with the entity and its title', () => {
    expect(inFeed(entry({ action: 'task.created' }))).toBe('created task API-12 “Fix login”');
    expect(inFeed(entry({ action: 'task.deleted' }))).toBe('deleted task API-12 “Fix login”');
    expect(inFeed(entry({ action: 'task.purged', meta: {} }))).toBe('permanently deleted a task');
    expect(inFeed(entry({ action: 'task.claimed' }))).toBe('claimed task API-12');
    expect(inFeed(entry({ action: 'task.released' }))).toBe('released the claim on task API-12');
    expect(
      inFeed(entry({ entityType: 'issue', action: 'issue.resolved', meta: { ref: 'API#4' } })),
    ).toBe('resolved issue API#4');
    expect(
      inFeed(entry({ entityType: 'project', action: 'project.created', meta: { name: 'Web' } })),
    ).toBe('created project Web');
  });

  it('has its own wording for replies, files, members, invites and the team', () => {
    const reply = { entityType: 'reply' as const, meta: { parentRef: 'API#4' } };
    expect(inFeed(entry({ ...reply, action: 'reply.created' }))).toBe('replied on API#4');
    expect(inFeed(entry({ ...reply, action: 'reply.edited' }))).toBe('edited a reply on API#4');
    expect(
      inFeed(
        entry({ ...reply, action: 'reply.edited', changes: { body: { from: 'a', to: 'b' } } }),
      ),
    ).toBe('edited a reply on API#4');
    expect(diffRows(entry({ ...reply, changes: { body: { from: 'a', to: 'b' } } }))[0]?.label).toBe(
      'text',
    );
    expect(inFeed(entry({ ...reply, action: 'reply.deleted' }))).toBe('deleted a reply on API#4');
    expect(
      inFeed(
        entry({
          entityType: 'attachment',
          action: 'attachment.uploaded',
          meta: { filename: 'a.png' },
        }),
      ),
    ).toBe('uploaded file a.png');
    expect(inFeed(entry({ entityType: 'member', action: 'member.joined', meta: {} }))).toBe(
      'joined the team',
    );
    expect(
      inFeed(entry({ entityType: 'member', action: 'member.removed', meta: { username: 'bob' } })),
    ).toBe('removed @bob from the team');
    expect(
      inFeed(
        entry({
          entityType: 'member',
          action: 'member.roles_changed',
          meta: { username: 'bob' },
          changes: { roles: { from: [], to: ['Admin'] } },
        }),
      ),
    ).toBe('added role Admin to @bob');
    expect(inFeed(entry({ entityType: 'invite', action: 'invite.created', meta: {} }))).toBe(
      'created an invite link',
    );
    expect(
      inFeed(
        entry({
          entityType: 'team',
          action: 'team.updated',
          meta: { name: 'Acme' },
          changes: { name: { from: 'Acme', to: 'Acme Inc' } },
        }),
      ),
    ).toBe('renamed the team from “Acme” to “Acme Inc”');
    expect(inFeed(entry({ action: 'task.link_added' }))).toBe('link added: task API-12');
  });

  it('words role reorders and default statuses as the teams and projects modules record them', () => {
    const reorder = entry({
      entityType: 'team',
      action: 'role.reordered',
      meta: {},
      changes: {
        order: { from: ['Admin', 'Frontend', 'Backend'], to: ['Admin', 'Backend', 'Frontend'] },
      },
    });
    expect(inFeed(reorder)).toBe('reordered the roles');
    expect(diffRows(reorder)).toEqual([
      {
        field: 'order',
        label: 'order',
        kind: 'value',
        from: 'Admin → Frontend → Backend',
        to: 'Admin → Backend → Frontend',
      },
    ]);
    const madeDefault = entry({
      entityType: 'status',
      action: 'status.updated',
      meta: { name: 'Todo' },
      changes: { isDefault: { from: false, to: true } },
    });
    expect(inFeed(madeDefault)).toBe('made Todo the default');
    expect(
      inFeed(
        entry({
          entityType: 'member',
          action: 'member.account_deleted',
          meta: { username: 'bob' },
        }),
      ),
    ).toBe('deleted their account and left the team');
    expect(onPage(madeDefault)).toBe('made this the default');
  });

  it('falls back to the title or the type when no ref was recorded', () => {
    expect(entityName(entry({ meta: { title: 'Fix login' } }))).toBe('Fix login');
    expect(inFeed(entry({ entityType: 'label', action: 'label.deleted', meta: {} }))).toBe(
      'deleted a label',
    );
  });
});

describe('diffRows', () => {
  it('turns changes into from → to rows', () => {
    expect(
      diffRows(
        entry({
          changes: {
            status: { from: 'Open', to: 'Done' },
            description: { from: 'a', to: 'b' },
            assignees: { from: ['ann'], to: ['bob'] },
            dueDate: { from: null, to: '2026-10-01' },
          },
        }),
      ),
    ).toEqual([
      { field: 'status', label: 'status', kind: 'value', from: 'Open', to: 'Done' },
      { field: 'description', label: 'description', kind: 'text', from: 'a', to: 'b' },
      { field: 'assignees', label: 'assignees', kind: 'list', added: ['bob'], removed: ['ann'] },
      { field: 'dueDate', label: 'due date', kind: 'value', from: 'none', to: '2026-10-01' },
    ]);
  });
});
