import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Principal, PrincipalRule, PrincipalScope } from '@shared/principals';
import * as s from '../db/schema';
import {
  addMember,
  createProject,
  createRole,
  createTeam,
  createTestContext,
  createUser,
  type CreatedProject,
  type CreatedTeam,
  type RoleRow,
  type TestContext,
  type UserRow,
} from '../test/helpers';
import { expandRule, matchesRule, type PrincipalContext } from './principals';

/**
 * The "who" rule resolver (design §2): people, agents (own role or through their owner), roles,
 * project roles and everyone; allow minus deny; only current team members.
 */

let ctx: TestContext;
let team: CreatedTeam;
let owner: UserRow;
let ann: UserRow; // reviewer
let ben: UserRow; // no role
let annAi: UserRow; // Ann's agent, no role of its own
let benAi: UserRow; // Ben's agent, holds Reviewer itself
let reviewer: RoleRow;
let api: CreatedProject;
let web: CreatedProject;
let qa: string; // project role of API held by Ben
let scope: PrincipalContext;

function agentOf(human: UserRow, username: string): UserRow {
  const agent = createUser(ctx.db, { username });
  return ctx.db.orm
    .update(s.user)
    .set({ kind: 'agent', agentOwnerId: human.id })
    .where(eq(s.user.id, agent.id))
    .returning()
    .get();
}

beforeEach(() => {
  ctx = createTestContext();
  owner = createUser(ctx.db, { username: 'owner' });
  ann = createUser(ctx.db, { username: 'ann' });
  ben = createUser(ctx.db, { username: 'ben' });
  annAi = agentOf(ann, 'ann-ai');
  benAi = agentOf(ben, 'ben-ai');
  team = createTeam(ctx.db, { ownerId: owner.id });
  reviewer = createRole(ctx.db, { teamId: team.team.id, name: 'Reviewer' });
  addMember(ctx.db, { teamId: team.team.id, userId: ann.id, roleIds: [reviewer.id] });
  addMember(ctx.db, { teamId: team.team.id, userId: ben.id });
  addMember(ctx.db, { teamId: team.team.id, userId: annAi.id });
  addMember(ctx.db, { teamId: team.team.id, userId: benAi.id, roleIds: [reviewer.id] });
  api = createProject(ctx.db, { teamId: team.team.id, key: 'API' });
  web = createProject(ctx.db, { teamId: team.team.id, key: 'WEB' });
  qa = ctx.db.orm
    .insert(s.projectRole)
    .values({ projectId: api.project.id, name: 'QA', slug: 'qa', position: 1 })
    .returning()
    .get().id;
  ctx.db.orm.insert(s.projectRoleMember).values({ projectRoleId: qa, userId: ben.id }).run();
  scope = { teamId: team.team.id, projectId: api.project.id };
});

afterEach(() => {
  ctx.close();
});

const rule = (allow: Principal[], deny: Principal[] = []): PrincipalRule => ({ allow, deny });
const names = (ids: readonly string[]) =>
  ids
    .map((id) => [owner, ann, ben, annAi, benAi].find((user) => user.id === id)?.username ?? id)
    .sort();
const expand = (r: PrincipalRule, context: PrincipalContext = scope) =>
  names(expandRule(ctx.db.orm, context, r));

describe('expandRule', () => {
  it('matches users who are current members only', () => {
    const outsider = createUser(ctx.db);
    expect(
      expand(
        rule([
          { type: 'user', userId: ann.id },
          { type: 'user', userId: annAi.id },
          { type: 'user', userId: outsider.id },
        ]),
      ),
    ).toEqual(['ann', 'ann-ai']);
  });

  it.each<[PrincipalScope, string[]]>([
    ['people', ['ann']],
    ['agents', ['ann-ai', 'ben-ai']],
    ['both', ['ann', 'ann-ai', 'ben-ai']],
  ])('scopes team roles: %s', (roleScope, expected) => {
    // ann-ai through its owner, ben-ai holding the role itself.
    expect(expand(rule([{ type: 'role', roleId: reviewer.id, scope: roleScope }]))).toEqual(
      expected,
    );
  });

  it('treats the @everyone role as every member', () => {
    expect(expand(rule([{ type: 'role', roleId: team.everyoneRole.id, scope: 'people' }]))).toEqual(
      ['ann', 'ben', 'owner'],
    );
  });

  it.each<[PrincipalScope, string[]]>([
    ['people', ['ben']],
    ['agents', ['ben-ai']],
    ['both', ['ben', 'ben-ai']],
  ])('scopes project roles of the context project: %s', (roleScope, expected) => {
    expect(expand(rule([{ type: 'project_role', roleId: qa, scope: roleScope }]))).toEqual(
      expected,
    );
  });

  it('ignores project roles of other projects, other teams’ roles, and no project', () => {
    const other = createTeam(ctx.db, { ownerId: owner.id });
    const qaRule = rule([{ type: 'project_role', roleId: qa, scope: 'both' }]);
    expect(expand(qaRule, { teamId: team.team.id, projectId: web.project.id })).toEqual([]);
    expect(expand(qaRule, { teamId: team.team.id })).toEqual([]);
    expect(expand(rule([{ type: 'role', roleId: other.adminRole.id, scope: 'both' }]))).toEqual([]);
    expect(expand(qaRule, { teamId: other.team.id, projectId: api.project.id })).toEqual([]);
  });

  it.each<[PrincipalScope, string[]]>([
    ['people', ['ann', 'ben', 'owner']],
    ['agents', ['ann-ai', 'ben-ai']],
    ['both', ['ann', 'ann-ai', 'ben', 'ben-ai', 'owner']],
  ])('expands everyone: %s', (everyoneScope, expected) => {
    expect(expand(rule([{ type: 'everyone', scope: everyoneScope }]))).toEqual(expected);
  });

  it('removes denied members from the allowed ones', () => {
    expect(
      expand(
        rule(
          [{ type: 'everyone', scope: 'both' }],
          [
            { type: 'role', roleId: reviewer.id, scope: 'agents' },
            { type: 'user', userId: owner.id },
          ],
        ),
      ),
    ).toEqual(['ann', 'ben']);
    // "People, but not agents": the canonical approval rule.
    expect(
      expand(rule([{ type: 'everyone', scope: 'both' }], [{ type: 'everyone', scope: 'agents' }])),
    ).toEqual(['ann', 'ben', 'owner']);
  });

  it('matches nobody with an empty allow list', () => {
    expect(expand(rule([], []))).toEqual([]);
  });

  it('never matches members who left, or deleted accounts', () => {
    ctx.db.orm.delete(s.teamMember).where(eq(s.teamMember.userId, ben.id)).run();
    // ben-ai stays a member, but its owner's project role no longer counts.
    expect(expand(rule([{ type: 'project_role', roleId: qa, scope: 'both' }]))).toEqual([]);
    ctx.db.orm.delete(s.user).where(eq(s.user.id, ann.id)).run();
    expect(expand(rule([{ type: 'role', roleId: reviewer.id, scope: 'both' }]))).toEqual([
      'ben-ai',
    ]);
  });
});

describe('matchesRule', () => {
  it('agrees with expandRule for every member and rule', () => {
    const rules: PrincipalRule[] = [
      rule([{ type: 'role', roleId: reviewer.id, scope: 'agents' }]),
      rule([{ type: 'role', roleId: reviewer.id, scope: 'people' }]),
      rule([{ type: 'project_role', roleId: qa, scope: 'both' }]),
      rule([{ type: 'everyone', scope: 'both' }], [{ type: 'user', userId: ann.id }]),
      rule([{ type: 'role', roleId: team.everyoneRole.id, scope: 'agents' }]),
      rule([{ type: 'user', userId: benAi.id }]),
      rule([]),
    ];
    for (const r of rules) {
      const expanded = new Set(expandRule(ctx.db.orm, scope, r));
      for (const user of [owner, ann, ben, annAi, benAi]) {
        expect(
          matchesRule(ctx.db.orm, scope, user.id, r),
          `${user.username} ${JSON.stringify(r)}`,
        ).toBe(expanded.has(user.id));
      }
    }
  });

  it('never matches non-members', () => {
    const outsider = createUser(ctx.db);
    expect(
      matchesRule(ctx.db.orm, scope, outsider.id, rule([{ type: 'user', userId: outsider.id }])),
    ).toBe(false);
    expect(
      matchesRule(ctx.db.orm, scope, outsider.id, rule([{ type: 'everyone', scope: 'both' }])),
    ).toBe(false);
  });
});
