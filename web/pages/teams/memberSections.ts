import type { Member } from '@shared/schemas/teams';

/**
 * The Members tab's grouping (docs/design/agents-and-pipelines.md §7), like Discord's member
 * list: one section per hoisted role, highest first, holding the members whose highest hoisted
 * role it is (people and agents together); then everyone else, people under "Members" and agents
 * under "Agents". Each section is split into who is online and who is offline, by name.
 */

export interface MemberSection {
  /** A role id, or `members` / `agents`. */
  id: string;
  title: string;
  /** The role's color, for a swatch next to the title. */
  color: string | null;
  online: Member[];
  offline: Member[];
}

const byName = (a: Member, b: Member) =>
  a.user.name.localeCompare(b.user.name, undefined, { sensitivity: 'base' }) ||
  (a.user.username ?? '').localeCompare(b.user.username ?? '');

export function memberSections(
  members: readonly Member[],
  online: ReadonlySet<string>,
): MemberSection[] {
  const roles = new Map<string, { section: MemberSection; position: number }>();
  const people: MemberSection = {
    id: 'members',
    title: 'Members',
    color: null,
    online: [],
    offline: [],
  };
  const agents: MemberSection = {
    id: 'agents',
    title: 'Agents',
    color: null,
    online: [],
    offline: [],
  };
  for (const member of members) {
    // Roles arrive highest first: the first hoisted one is the member's section.
    const hoisted = member.roles.find((role) => role.hoist);
    let section: MemberSection;
    if (hoisted) {
      const existing = roles.get(hoisted.id);
      section = existing?.section ?? {
        id: hoisted.id,
        title: hoisted.name,
        color: hoisted.color,
        online: [],
        offline: [],
      };
      if (!existing) roles.set(hoisted.id, { section, position: hoisted.position });
    } else {
      section = member.user.kind === 'agent' ? agents : people;
    }
    (online.has(member.user.id) ? section.online : section.offline).push(member);
  }
  const sections = [
    ...[...roles.values()].sort((a, b) => b.position - a.position).map((entry) => entry.section),
    people,
    agents,
  ].filter((section) => section.online.length + section.offline.length > 0);
  for (const section of sections) {
    section.online.sort(byName);
    section.offline.sort(byName);
  }
  return sections;
}
