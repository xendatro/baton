/**
 * TanStack Query key factories for every entity. Keys are hierarchical so a prefix invalidates
 * everything below it: `['teams', teamId]` covers members, roles, invites, audit log, …;
 * `['projects', projectId]` covers statuses, labels, issues and tasks. Keys use ids (not slugs or
 * keys from the URL) so live events, which carry ids, can target them (see live.ts).
 */

/** Filter/sort/pagination params that are part of a list key. Keep them JSON-serialisable. */
export type KeyParams = Readonly<
  Record<string, string | number | boolean | null | undefined | readonly string[]>
>;

export const queryKeys = {
  config: () => ['config'] as const,
  /** Better Auth session (`GET /api/auth/get-session`); null when signed out. */
  session: () => ['session'] as const,
  usernameAvailable: (username: string) => ['auth', 'username-available', username] as const,
  me: () => ['me'] as const,
  apiKeys: () => ['me', 'api-keys'] as const,

  notifications: {
    all: () => ['notifications'] as const,
    list: (params: KeyParams = {}) => ['notifications', 'list', params] as const,
    unreadCount: () => ['notifications', 'unread-count'] as const,
  },

  teams: {
    all: () => ['teams'] as const,
    detail: (teamId: string) => ['teams', teamId] as const,
    members: (teamId: string) => ['teams', teamId, 'members'] as const,
    /** Who of the team is online (design §4 presence, the Members tab). */
    presence: (teamId: string) => ['teams', teamId, 'presence'] as const,
    roles: (teamId: string) => ['teams', teamId, 'roles'] as const,
    invites: (teamId: string) => ['teams', teamId, 'invites'] as const,
    /** Connected GitHub accounts; `repos` and `contents` feed the README source picker. */
    github: (teamId: string) => ['teams', teamId, 'github'] as const,
    githubRepos: (teamId: string) => ['teams', teamId, 'github', 'repos'] as const,
    githubContents: (teamId: string, installationId: string, repo: string, path: string) =>
      ['teams', teamId, 'github', 'contents', installationId, repo, path] as const,
    projects: (teamId: string) => ['teams', teamId, 'projects'] as const,
    /** Team home (team + project cards): under `projects` so project events refresh it. */
    overview: (teamId: string) => ['teams', teamId, 'projects', 'overview'] as const,
    /** Is a project key free in the team (new project, or `projectId` changing its key)? */
    projectKeyCheck: (teamId: string, key: string, projectId?: string) =>
      ['teams', teamId, 'projects', 'key-check', key, projectId ?? null] as const,
    /** A project key of the team, possibly a previous one (old URLs redirect). */
    projectByKey: (teamId: string, key: string) =>
      ['teams', teamId, 'projects', 'by-key', key] as const,
    /** Without `q`: prefix of every mentionables query of the team. */
    mentionables: (teamId: string, q?: string) =>
      q === undefined
        ? (['teams', teamId, 'mentionables'] as const)
        : (['teams', teamId, 'mentionables', q] as const),
    /** Exact lookup of the mentions in a body (`names`: a stable string of them). */
    mentionLookup: (teamId: string, names?: string) =>
      names === undefined
        ? (['teams', teamId, 'mentionables', 'lookup'] as const)
        : (['teams', teamId, 'mentionables', 'lookup', names] as const),
    /** Without `params`: prefix of every audit-log query of the team. */
    auditLog: (teamId: string, params?: KeyParams) =>
      params === undefined
        ? (['teams', teamId, 'audit-log'] as const)
        : (['teams', teamId, 'audit-log', params] as const),
    /**
     * The audit log page's loaded rows. Outside the `auditLog` prefix on purpose: live events
     * would refetch every loaded page; new rows arrive through an `auditLog` query instead.
     */
    auditLogFeed: (teamId: string, params: KeyParams) =>
      ['teams', teamId, 'audit-log-feed', params] as const,
    auditLogFacets: (teamId: string) => ['teams', teamId, 'audit-log-facets'] as const,
    /** Without `params`: prefix of every trash query of the team. */
    trash: (teamId: string, params?: KeyParams) =>
      params === undefined
        ? (['teams', teamId, 'trash'] as const)
        : (['teams', teamId, 'trash', params] as const),
  },

  /** Public preview of an invite link (`/join/:code`). */
  invite: (code: string) => ['invites', code] as const,

  projects: {
    detail: (projectId: string) => ['projects', projectId] as const,
    statuses: (projectId: string) => ['projects', projectId, 'statuses'] as const,
    /** The project's pipelines the viewer can see (BAT-25). */
    pipelines: (projectId: string) => ['projects', projectId, 'pipelines'] as const,
    labels: (projectId: string) => ['projects', projectId, 'labels'] as const,
    /** Difficulty levels, easiest first (BAT-24). */
    difficulties: (projectId: string) => ['projects', projectId, 'difficulties'] as const,
    /** Project roles and their members (design §3). */
    roles: (projectId: string) => ['projects', projectId, 'roles'] as const,
    /** The project's permission overrides and the viewer's permissions there. */
    permissions: (projectId: string) => ['projects', projectId, 'permissions'] as const,
    /** What copying another project's pipeline into this one would do (design §5). */
    pipelineCopy: (projectId: string, fromProjectId: string) =>
      ['projects', projectId, 'pipeline-copy', fromProjectId] as const,
    /** A document of the project's GitHub README (`path` null: the first one). */
    githubReadme: (projectId: string, path: string | null) =>
      ['projects', projectId, 'readme', 'github', path] as const,
  },

  issues: {
    all: (projectId: string) => ['projects', projectId, 'issues'] as const,
    list: (projectId: string, params: KeyParams = {}) =>
      ['projects', projectId, 'issues', 'list', params] as const,
    /** Prefix of every issue page of the project (live reaction changes carry no number). */
    details: (projectId: string) => ['projects', projectId, 'issues', 'detail'] as const,
    detail: (projectId: string, number: number) =>
      ['projects', projectId, 'issues', 'detail', number] as const,
  },

  tasks: {
    all: (projectId: string) => ['projects', projectId, 'tasks'] as const,
    list: (projectId: string, params: KeyParams = {}) =>
      ['projects', projectId, 'tasks', 'list', params] as const,
    /** Prefix of every task page of the project (live reaction changes carry no number). */
    details: (projectId: string) => ['projects', projectId, 'tasks', 'detail'] as const,
    detail: (projectId: string, number: number) =>
      ['projects', projectId, 'tasks', 'detail', number] as const,
  },

  replies: {
    all: () => ['replies'] as const,
    list: (parentType: string, parentId: string) => ['replies', parentType, parentId] as const,
    /** One view of an item's comment tree (BAT-13); `list` covers every view of the item. */
    tree: (parentType: string, parentId: string, view: KeyParams) =>
      ['replies', parentType, parentId, view] as const,
  },

  activity: (entityType: string, entityId: string) => ['activity', entityType, entityId] as const,
  attachments: (parentType: string, parentId: string) =>
    ['attachments', parentType, parentId] as const,
  subscription: (entityType: string, entityId: string) =>
    ['subscriptions', entityType, entityId] as const,
  search: (params: KeyParams) => ['search', params] as const,

  work: {
    all: () => ['work'] as const,
    myTasks: (params: KeyParams = {}) => ['work', 'my-tasks', params] as const,
    dashboard: () => ['work', 'dashboard'] as const,
  },

  account: {
    all: () => ['account'] as const,
    sessions: () => ['account', 'sessions'] as const,
    connections: () => ['account', 'connections'] as const,
    securityLog: () => ['account', 'security-log'] as const,
    deletedTeams: () => ['account', 'deleted-teams'] as const,
    /** Your agent member and its settings (`GET /api/me/agent`). */
    agent: () => ['account', 'agent'] as const,
    /** Your agent's listener sessions and latest jobs (`GET /api/me/agent/activity`). */
    agentActivity: () => ['account', 'agent', 'activity'] as const,
    /** Automatic agents (BAT-24): desktop runners, jobs waiting for your OK, settings, stats. */
    agentRunners: () => ['account', 'agent', 'runners'] as const,
    agentWaiting: () => ['account', 'agent', 'waiting'] as const,
    /** The stored output tail of a job's last run (BAT#23), refreshed with the waiting jobs. */
    agentJobOutput: (jobId: string) => ['account', 'agent', 'waiting', 'output', jobId] as const,
    /** The latest failed run per harness and model, for the chain editors (BAT#23). */
    agentModelFailures: () => ['account', 'agent', 'model-failures'] as const,
    agentJobSources: () => ['account', 'agent', 'job-sources'] as const,
    agentModels: () => ['account', 'agent', 'models'] as const,
    agentStats: (days: number) => ['account', 'agent', 'stats', days] as const,
    /**
     * Is your agent connected to a project (a runner's folder or a listener)? Without
     * `projectId`: the prefix of every project's.
     */
    agentConnection: (projectId?: string, taskId?: string | null) =>
      projectId === undefined
        ? (['account', 'agent', 'connection'] as const)
        : (['account', 'agent', 'connection', projectId, taskId ?? null] as const),
    /** Without `params`: every list of your agent's sign-off requests (design §6). */
    agentActions: (params?: KeyParams) =>
      params === undefined
        ? (['account', 'agent-actions'] as const)
        : (['account', 'agent-actions', params] as const),
    /** Your settings for one project (BAT-29); `me.updated` refreshes them. */
    projectSettings: (projectId: string) => ['account', 'project-settings', projectId] as const,
  },
};
