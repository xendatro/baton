import { describe, expect, it } from 'vitest';
import { testMe } from '@web/test/mockApi';
import {
  assignmentHint,
  filtersToParams,
  groupTasks,
  hasActiveFilters,
  parseFilters,
  toQueryFilters,
} from './filters';
import { myTask } from './testing';

describe('My tasks filters', () => {
  it('round-trips the URL, dropping defaults and unknown values', () => {
    const state = parseFilters(
      new URLSearchParams(
        'team=ACME&project=acme/WEB&priority=urgent,bogus,high&due=week&sort=due&q=login',
      ),
    );
    expect(state).toEqual({
      team: 'acme',
      project: 'acme/WEB',
      priority: ['high', 'urgent'],
      due: 'week',
      q: 'login',
      sort: 'due',
    });
    expect(filtersToParams(state).toString()).toBe(
      'team=acme&project=acme%2FWEB&priority=high%2Curgent&due=week&q=login&sort=due',
    );
    const empty = parseFilters(new URLSearchParams('due=later&sort=weird'));
    expect(empty).toMatchObject({ due: null, sort: 'priority', priority: [] });
    expect(hasActiveFilters(empty)).toBe(false);
    expect(filtersToParams(empty).toString()).toBe('');
  });

  it('resolves slugs and keys to ids, and refuses ones the viewer cannot see', () => {
    const teams = testMe().teams;
    const base = parseFilters(new URLSearchParams(''));
    expect(toQueryFilters({ ...base, project: 'acme/web' }, teams)).toMatchObject({
      teamId: 't1',
      projectId: 'p1',
    });
    expect(toQueryFilters({ ...base, team: 'acme' }, teams)).toMatchObject({ teamId: 't1' });
    expect(toQueryFilters({ ...base, team: 'nope' }, teams)).toBeNull();
    expect(toQueryFilters({ ...base, project: 'acme/API' }, teams)).toBeNull();
  });

  it('groups tasks by team and project alphabetically, keeping the order inside', () => {
    const zed = { id: 't2', slug: 'zed', name: 'Zed', icon: null, color: '#000000' };
    const api = { id: 'p2', key: 'API', name: 'API', icon: null, color: '#000000' };
    const groups = groupTasks([
      myTask({ id: 'a', team: zed, project: api }),
      myTask({ id: 'b' }),
      myTask({ id: 'c', project: api }),
      myTask({ id: 'd' }),
    ]);
    expect(
      groups.map((group) => [
        group.team.name,
        group.count,
        group.projects.map((project) => [
          project.project.key,
          project.tasks.map((task) => task.id),
        ]),
      ]),
    ).toEqual([
      [
        'Acme',
        3,
        [
          ['API', ['c']],
          ['WEB', ['b', 'd']],
        ],
      ],
      ['Zed', 1, [['API', ['a']]]],
    ]);
  });

  it('explains role-only assignments', () => {
    const backend = { id: 'r1', slug: 'backend', name: 'Backend', color: null };
    expect(assignmentHint(myTask())).toBeNull();
    expect(assignmentHint(myTask({ assignment: { direct: false, roles: [backend] } }))).toBe(
      'via Backend',
    );
    expect(assignmentHint(myTask({ assignment: { direct: true, roles: [backend] } }))).toBeNull();
  });
});
