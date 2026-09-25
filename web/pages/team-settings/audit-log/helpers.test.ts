import { describe, expect, it } from 'vitest';
import type { ActivityEntry } from '@shared/schemas/core';
import { highlightSegments, searchTerms } from '@web/lib/highlight';
import { auditLogCsv, csvFileName } from './csv';
import { dayLabel, groupByDay } from './days';
import {
  activeFilterCount,
  describeRange,
  EMPTY_FILTERS,
  readFilters,
  toApiQuery,
  writeFilters,
} from './filters';
import { actionOptions } from './labels';

function entry(overrides: Partial<ActivityEntry>): ActivityEntry {
  return {
    id: 'a1',
    teamId: 't1',
    projectId: 'p1',
    actor: {
      user: { id: 'u1', username: 'mia', name: 'Mia', image: null },
      via: null,
      source: 'web',
    },
    entityType: 'task',
    entityId: 'task1',
    action: 'task.status_changed',
    changes: { status: { from: 'Open', to: 'Done' } },
    meta: { ref: 'API-12', title: 'Fix login' },
    url: '/t/acme/p/API/tasks/12',
    createdAt: '2026-09-24T10:00:00.000Z',
    ...overrides,
  };
}

describe('audit log filters', () => {
  it('reads valid URL params and drops malformed ones', () => {
    const filters = readFilters(
      new URLSearchParams(
        'actor=01HZUSER&source=mcp&key=bad id&entity=task&action=task.&project=P1&from=2026-09-01&to=2026-02-30',
      ),
    );
    expect(filters).toEqual({
      actor: '01HZUSER',
      source: 'mcp',
      key: null,
      entity: 'task',
      action: 'task.',
      project: 'P1',
      from: '2026-09-01',
      to: null,
    });
    expect(
      readFilters(new URLSearchParams('source=email&entity=widget&action=DROP TABLE')),
    ).toEqual(EMPTY_FILTERS);
    expect(activeFilterCount(filters)).toBe(6);
  });

  it('writes filters back, keeping unrelated params', () => {
    const params = writeFilters(new URLSearchParams('tab=x&actor=old'), {
      ...EMPTY_FILTERS,
      source: 'api',
      from: '2026-09-01',
    });
    expect(params.toString()).toBe('tab=x&source=api&from=2026-09-01');
  });

  it('turns calendar days into an inclusive local range for the API', () => {
    const query = toApiQuery({ ...EMPTY_FILTERS, from: '2026-09-01', to: '2026-09-03', key: 'k1' });
    expect(query.keyId).toBe('k1');
    expect(new Date(query.from ?? '').getDate()).toBe(1);
    expect(new Date(query.from ?? '').getHours()).toBe(0);
    // `to` is exclusive on the server: the next local midnight.
    expect(new Date(query.to ?? '').getDate()).toBe(4);
    expect(new Date(query.to ?? '').getHours()).toBe(0);
    expect(toApiQuery(EMPTY_FILTERS)).toEqual({});
  });

  it('describes date ranges', () => {
    const now = new Date(2026, 8, 25);
    expect(describeRange('2026-09-01', '2026-09-03', now)).toBe('Sep 1 – Sep 3');
    expect(describeRange('2026-09-01', '2026-09-01', now)).toBe('Sep 1');
    expect(describeRange('2025-12-30', null, now)).toBe('Since Dec 30, 2025');
    expect(describeRange(null, '2026-09-03', now)).toBe('Until Sep 3');
    expect(describeRange(null, null, now)).toBeNull();
  });

  it('offers per-entity action groups', () => {
    const options = actionOptions(['reply.created', 'task.claimed', 'task.status_changed']);
    expect(options.map((option) => [option.group, option.value, option.label])).toEqual([
      ['Reply', 'reply.created', 'Created'],
      ['Task', 'task.', 'All task actions'],
      ['Task', 'task.claimed', 'Claimed'],
      ['Task', 'task.status_changed', 'Status changed'],
    ]);
  });
});

describe('groupByDay', () => {
  it('groups newest-first rows by local day with friendly labels', () => {
    const now = new Date(2026, 8, 25, 12);
    const at = (day: number, hour: number) => new Date(2026, 8, day, hour).toISOString();
    const groups = groupByDay(
      [
        entry({ id: 'a', createdAt: at(25, 9) }),
        entry({ id: 'b', createdAt: at(25, 8) }),
        entry({ id: 'c', createdAt: at(24, 23) }),
        entry({ id: 'd', createdAt: at(20, 10) }),
      ],
      now,
    );
    expect(groups.map((group) => [group.label, group.entries.map((e) => e.id)])).toEqual([
      ['Today', ['a', 'b']],
      ['Yesterday', ['c']],
      ['Sunday, September 20', ['d']],
    ]);
    expect(dayLabel(new Date(2025, 0, 2), now)).toBe('Thursday, January 2, 2025');
  });
});

describe('auditLogCsv', () => {
  it('writes one quoted row per entry with the sentence and absolute URLs', () => {
    const csv = auditLogCsv(
      [
        entry({}),
        entry({
          id: 'b',
          actor: {
            user: { id: 'u2', username: 'bot', name: '=cmd, "evil"', image: null },
            via: { keyId: 'k1', keyName: 'Claude' },
            source: 'mcp',
          },
          action: 'task.created',
          changes: {},
          url: null,
        }),
        entry({ id: 'c', actor: { user: null, via: null, source: 'system' }, changes: {} }),
      ],
      'https://baton.example',
    );
    const lines = csv.split('\r\n');
    expect(lines[0]).toBe(
      'time,actor_username,actor_name,source,via_key,action,summary,entity_type,entity_id,url,changes',
    );
    expect(lines[1]).toBe(
      '2026-09-24T10:00:00.000Z,mia,Mia,web,,task.status_changed,moved API-12 from Open to Done,task,task1,https://baton.example/t/acme/p/API/tasks/12,"{""status"":{""from"":""Open"",""to"":""Done""}}"',
    );
    expect(lines[2]).toContain(`"'=cmd, ""evil""",mcp,Claude,task.created`);
    expect(lines[3]).toContain('system,Baton,system');
    expect(csv.endsWith('\r\n')).toBe(true);
    expect(csvFileName('acme', new Date(2026, 0, 5))).toBe('audit-log-acme-2026-01-05.csv');
  });
});

describe('highlight', () => {
  it('marks word prefixes of the query terms', () => {
    const terms = searchTerms('Crash lo');
    expect(terms).toEqual(['crash', 'lo']);
    expect(highlightSegments('Login crashes on slow networks', terms)).toEqual([
      { text: 'Lo', match: true },
      { text: 'gin ', match: false },
      { text: 'crash', match: true },
      { text: 'es on slow networks', match: false },
    ]);
    expect(highlightSegments('nothing', [])).toEqual([{ text: 'nothing', match: false }]);
    expect(searchTerms('a+b (c)')).toEqual(['a', 'b', 'c']);
  });
});
