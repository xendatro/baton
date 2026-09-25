import type { ActivityEntityType, ActorSource } from '@shared/constants';
import type { FilterOption } from './FilterMenu';

/** Labels of the audit log's filter values. */

export const SOURCE_LABELS: Record<ActorSource, string> = {
  web: 'Web app',
  mcp: 'MCP (agents)',
  api: 'REST API',
  system: 'System',
};

export const ENTITY_LABELS: Record<ActivityEntityType, string> = {
  task: 'Tasks',
  issue: 'Issues',
  reply: 'Replies',
  attachment: 'Files',
  project: 'Projects',
  status: 'Statuses',
  label: 'Labels',
  team: 'Team',
  member: 'Members',
  role: 'Roles',
  invite: 'Invite links',
  user: 'Accounts',
  api_key: 'API keys',
};

const ENTITY_SINGULAR: Partial<Record<string, string>> = {
  task: 'Task',
  issue: 'Issue',
  reply: 'Reply',
  attachment: 'File',
  project: 'Project',
  status: 'Status',
  label: 'Label',
  team: 'Team',
  member: 'Member',
  role: 'Role',
  invite: 'Invite',
  user: 'Account',
  api_key: 'API key',
};

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** Action filter options: per entity, "All task actions" (`task.`) and each action seen. */
export function actionOptions(actions: readonly string[]): FilterOption[] {
  const byPrefix = new Map<string, string[]>();
  for (const action of actions) {
    const [prefix = action] = action.split('.');
    byPrefix.set(prefix, [...(byPrefix.get(prefix) ?? []), action]);
  }
  return [...byPrefix.entries()].flatMap(([prefix, list]) => {
    const group = ENTITY_SINGULAR[prefix] ?? capitalize(prefix.replace(/_/g, ' '));
    const verbs = list.map((action): FilterOption => ({
      value: action,
      label: capitalize(action.slice(prefix.length + 1).replace(/[._]/g, ' ') || action),
      description: action,
      group,
    }));
    return list.length > 1
      ? [
          {
            value: `${prefix}.`,
            label: `All ${group.toLowerCase()} actions`,
            description: `${prefix}.*`,
            group,
          },
          ...verbs,
        ]
      : verbs;
  });
}
