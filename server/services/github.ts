import crypto from 'node:crypto';
import { and, eq, inArray } from 'drizzle-orm';
import {
  GITHUB_LIMITS,
  isMarkdownPath,
  type GithubEntry,
  type GithubInstallation,
  type GithubReadme,
  type GithubRepo,
  type GithubStatus,
  type ReadmeSource,
} from '@shared/schemas/github';
import type { Actor, AppDeps } from '../context';
import type { DbExecutor } from '../db';
import * as s from '../db/schema';
import { errors } from '../lib/errors';
import { newId } from '../lib/ids';
import { GithubError, type GithubClient } from '../lib/github';
import { requirePermission } from './access';
import { recordActivity } from './activity';
import { emitAfterCommit } from './events';
import { requireProject } from './projects';
import { requireTeam } from './teams';
import { getUserSummaries } from './users';

/**
 * GitHub (repository READMEs). A team connects GitHub accounts by installing the Baton GitHub
 * App (`MANAGE_TEAM`, web only): the install sends the browser back to `/api/github/setup`, which
 * has GitHub confirm through OAuth that the person can access that installation before it is
 * saved (an installation id alone proves nothing). A project (`MANAGE_PROJECTS`) can then show a
 * Markdown file of a connected repository, or a folder of them as a tree, instead of its own
 * README. Every read goes through the installation's token; nothing is stored but the source.
 */

// ---------------------------------------------------------------------------------------------
// Signed state (install → setup → verify)
// ---------------------------------------------------------------------------------------------

interface GithubState {
  kind: 'install' | 'verify';
  teamId: string;
  userId: string;
  /** `verify`: GitHub's installation id. */
  installationId?: number;
  expiresAt: number;
}

const STATE_TTL_MS = 30 * 60_000;

function sign(deps: AppDeps, payload: string): string {
  return crypto
    .createHmac('sha256', deps.env.authSecret)
    .update(`github-state:${payload}`)
    .digest('base64url');
}

function encodeState(deps: AppDeps, state: Omit<GithubState, 'expiresAt'>): string {
  const payload = Buffer.from(
    JSON.stringify({ ...state, expiresAt: Date.now() + STATE_TTL_MS }),
  ).toString('base64url');
  return `${payload}.${sign(deps, payload)}`;
}

function decodeState(deps: AppDeps, value: string | undefined, userId: string): GithubState {
  const [payload, signature] = (value ?? '').split('.');
  const invalid = () => errors.validation('This GitHub link expired or isn’t yours. Try again.');
  if (!payload || !signature) throw invalid();
  const expected = Buffer.from(sign(deps, payload));
  const given = Buffer.from(signature);
  if (expected.length !== given.length || !crypto.timingSafeEqual(expected, given)) throw invalid();
  const state = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as GithubState;
  if (state.expiresAt < Date.now() || state.userId !== userId) throw invalid();
  return state;
}

// ---------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------

function requireClient(deps: AppDeps): GithubClient {
  if (!deps.github) throw errors.conflict('GitHub isn’t set up on this server');
  return deps.github;
}

/** GitHub failures in words: missing things are 404s, the rest "couldn't reach GitHub". */
async function viaGithub<T>(what: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (cause) {
    if (cause instanceof GithubError) {
      if (cause.status === 404) throw errors.notFound(what);
      if (cause.status === 413) throw errors.payloadTooLarge(`${what} is too large to show`);
      if (cause.status === 401 || cause.status === 403) {
        throw errors.conflict(
          'GitHub refused access. Check that the Baton app can still see this repository.',
        );
      }
      throw errors.conflict('Couldn’t reach GitHub. Try again in a moment.');
    }
    throw cause;
  }
}

type InstallationRow = typeof s.githubInstallation.$inferSelect;

function installationRow(db: DbExecutor, teamId: string, id: string): InstallationRow {
  const row = db
    .select()
    .from(s.githubInstallation)
    .where(and(eq(s.githubInstallation.id, id), eq(s.githubInstallation.teamId, teamId)))
    .get();
  if (!row) throw errors.notFound('GitHub connection');
  return row;
}

function toInstallations(db: DbExecutor, rows: InstallationRow[]): GithubInstallation[] {
  const users = getUserSummaries(
    db,
    rows.flatMap((row) => (row.createdById ? [row.createdById] : [])),
  );
  return rows.map((row) => ({
    id: row.id,
    accountLogin: row.accountLogin,
    accountType: row.accountType,
    settingsUrl:
      row.accountType === 'Organization'
        ? `https://github.com/organizations/${row.accountLogin}/settings/installations/${row.installationId}`
        : `https://github.com/settings/installations/${row.installationId}`,
    createdBy: row.createdById ? (users.get(row.createdById) ?? null) : null,
    createdAt: row.createdAt.toISOString(),
  }));
}

function requireWeb(actor: Actor): void {
  if (actor.source !== 'web') {
    throw errors.forbidden('Connect GitHub from the web app, signed in as yourself');
  }
}

// ---------------------------------------------------------------------------------------------
// Connections (team settings → Integrations)
// ---------------------------------------------------------------------------------------------

/** Whether GitHub is available, and the team's connected accounts (any member). */
export function getGithubStatus(deps: AppDeps, actor: Actor, teamId: string): GithubStatus {
  const { orm } = deps.db;
  requireTeam(orm, actor, teamId);
  const rows = orm
    .select()
    .from(s.githubInstallation)
    .where(eq(s.githubInstallation.teamId, teamId))
    .orderBy(s.githubInstallation.createdAt)
    .all();
  return { enabled: deps.github !== null, installations: toInstallations(orm, rows) };
}

/** Where to send the browser to install the app for this team (`MANAGE_TEAM`). */
export function startGithubInstall(deps: AppDeps, actor: Actor, teamId: string): { url: string } {
  const client = requireClient(deps);
  requireWeb(actor);
  const { membership } = requireTeam(deps.db.orm, actor, teamId);
  requirePermission(
    membership,
    'MANAGE_TEAM',
    'Only people who can manage the team connect GitHub',
  );
  return {
    url: client.installUrl(encodeState(deps, { kind: 'install', teamId, userId: actor.userId })),
  };
}

function verifyRedirectUri(deps: AppDeps): string {
  return `${deps.env.baseUrl}/api/github/verify`;
}

function integrationsPath(db: DbExecutor, teamId: string, outcome: string): string {
  const team = db.select({ slug: s.team.slug }).from(s.team).where(eq(s.team.id, teamId)).get();
  return `/t/${team?.slug ?? ''}/settings/integrations?github=${outcome}`;
}

/**
 * GitHub's setup URL, after the app was installed or its repositories changed: sends the browser
 * on to GitHub's OAuth page so the installation can be checked against the person. Returns where
 * to redirect.
 */
export function githubSetupRedirect(
  deps: AppDeps,
  actor: Actor,
  query: { installation_id?: string; setup_action?: string; state?: string },
): string {
  const client = requireClient(deps);
  const state = decodeState(deps, query.state, actor.userId);
  if (state.kind !== 'install') throw errors.validation('Unexpected GitHub state');
  if (query.setup_action === 'request') {
    // An organization owner still has to approve the install on GitHub.
    return integrationsPath(deps.db.orm, state.teamId, 'requested');
  }
  const installationId = Number(query.installation_id);
  if (!Number.isInteger(installationId) || installationId <= 0) {
    throw errors.validation('GitHub didn’t say which installation this is');
  }
  return client.authorizeUrl(
    encodeState(deps, {
      kind: 'verify',
      teamId: state.teamId,
      userId: actor.userId,
      installationId,
    }),
    verifyRedirectUri(deps),
  );
}

/**
 * GitHub's OAuth callback: saves the installation for the team when the person can access it on
 * GitHub (a team can hold several: accounts and organizations). Returns where to redirect.
 */
export async function completeGithubInstall(
  deps: AppDeps,
  actor: Actor,
  query: { code?: string; state?: string },
): Promise<string> {
  const client = requireClient(deps);
  const state = decodeState(deps, query.state, actor.userId);
  if (state.kind !== 'verify' || !state.installationId || !query.code) {
    throw errors.validation('Unexpected GitHub state');
  }
  const { installationId, teamId } = state;
  const { membership } = requireTeam(deps.db.orm, actor, teamId);
  requirePermission(membership, 'MANAGE_TEAM');
  const code = query.code;
  const allowed = await viaGithub('GitHub installation', () =>
    client.userInstallationIds(code, verifyRedirectUri(deps)),
  );
  if (!allowed.includes(installationId)) return integrationsPath(deps.db.orm, teamId, 'denied');
  const account = await viaGithub('GitHub installation', () => client.installation(installationId));

  deps.db.write((tx) => {
    const existing = tx
      .select({ id: s.githubInstallation.id })
      .from(s.githubInstallation)
      .where(
        and(
          eq(s.githubInstallation.teamId, teamId),
          eq(s.githubInstallation.installationId, installationId),
        ),
      )
      .get();
    if (existing) {
      tx.update(s.githubInstallation)
        .set({ accountLogin: account.login, accountType: account.type })
        .where(eq(s.githubInstallation.id, existing.id))
        .run();
      return;
    }
    const id = newId();
    tx.insert(s.githubInstallation)
      .values({
        id,
        teamId,
        installationId,
        accountLogin: account.login,
        accountType: account.type,
        createdById: actor.userId,
        createdAt: new Date(),
      })
      .run();
    recordActivity(tx, actor, {
      teamId,
      entityType: 'team',
      entityId: teamId,
      action: 'team.github_connected',
      meta: { account: account.login },
    });
    emitAfterCommit(tx, {
      type: 'team.updated',
      teamId,
      entityType: 'team',
      entityId: teamId,
      actorId: actor.userId,
    });
  });
  return integrationsPath(deps.db.orm, teamId, 'connected');
}

/**
 * Disconnects a GitHub account from the team (`MANAGE_TEAM`); projects showing its repositories
 * go back to their own README. The app stays installed on GitHub (uninstall it there).
 */
export function disconnectGithub(deps: AppDeps, actor: Actor, teamId: string, id: string): void {
  const { membership } = requireTeam(deps.db.orm, actor, teamId);
  requirePermission(
    membership,
    'MANAGE_TEAM',
    'Only people who can manage the team disconnect GitHub',
  );
  const row = installationRow(deps.db.orm, teamId, id);
  deps.db.write((tx) => {
    const projects = tx
      .select({ id: s.project.id, readmeSource: s.project.readmeSource })
      .from(s.project)
      .where(eq(s.project.teamId, teamId))
      .all()
      .filter((project) => project.readmeSource?.installationId === row.id);
    if (projects.length > 0) {
      tx.update(s.project)
        .set({ readmeSource: null, updatedAt: new Date() })
        .where(
          inArray(
            s.project.id,
            projects.map((project) => project.id),
          ),
        )
        .run();
    }
    tx.delete(s.githubInstallation).where(eq(s.githubInstallation.id, row.id)).run();
    recordActivity(tx, actor, {
      teamId,
      entityType: 'team',
      entityId: teamId,
      action: 'team.github_disconnected',
      meta: { account: row.accountLogin, projects: projects.length },
    });
    emitAfterCommit(tx, {
      type: 'team.updated',
      teamId,
      entityType: 'team',
      entityId: teamId,
      actorId: actor.userId,
    });
  });
}

// ---------------------------------------------------------------------------------------------
// Browsing (the README source picker)
// ---------------------------------------------------------------------------------------------

/** Every repository the team's installations can see (`MANAGE_PROJECTS`). */
export async function listGithubRepos(
  deps: AppDeps,
  actor: Actor,
  teamId: string,
): Promise<{ repos: GithubRepo[] }> {
  const client = requireClient(deps);
  const { orm } = deps.db;
  const { membership } = requireTeam(orm, actor, teamId);
  requirePermission(membership, 'MANAGE_PROJECTS');
  const rows = orm
    .select()
    .from(s.githubInstallation)
    .where(eq(s.githubInstallation.teamId, teamId))
    .all();
  const lists = await Promise.all(
    rows.map((row) =>
      viaGithub('GitHub repositories', () => client.repos(row.installationId)).then((repos) =>
        repos.map((repo) => ({ ...repo, installationId: row.id })),
      ),
    ),
  );
  return { repos: lists.flat().sort((a, b) => a.fullName.localeCompare(b.fullName)) };
}

/** The entries of a folder of a repository (`MANAGE_PROJECTS`), folders first. */
export async function listGithubContents(
  deps: AppDeps,
  actor: Actor,
  teamId: string,
  installationId: string,
  query: { repo: string; path: string; ref?: string | undefined },
): Promise<{ entries: GithubEntry[] }> {
  const client = requireClient(deps);
  const { orm } = deps.db;
  const { membership } = requireTeam(orm, actor, teamId);
  requirePermission(membership, 'MANAGE_PROJECTS');
  const row = installationRow(orm, teamId, installationId);
  const ref =
    query.ref ??
    (await viaGithub('Repository', () => client.repo(row.installationId, query.repo)))
      .defaultBranch;
  const contents = await viaGithub('Folder', () =>
    client.contents(row.installationId, query.repo, query.path, ref),
  );
  if (contents.type !== 'dir') throw errors.validation('That path is a file, not a folder');
  return {
    entries: contents.entries.sort((a, b) =>
      a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1,
    ),
  };
}

// ---------------------------------------------------------------------------------------------
// A project's README source
// ---------------------------------------------------------------------------------------------

/**
 * Points the project's overview at a GitHub file or folder, or back to its own README with null
 * (`MANAGE_PROJECTS`). The path is checked on GitHub first: a file must be Markdown, a folder a
 * folder.
 */
export async function setReadmeSource(
  deps: AppDeps,
  actor: Actor,
  projectId: string,
  source: ReadmeSource | null,
): Promise<{ readmeSource: ReadmeSource | null }> {
  const { orm } = deps.db;
  const { project, membership } = requireProject(orm, actor, projectId);
  requirePermission(membership, 'MANAGE_PROJECTS', "You don't have permission to edit projects");
  let account: string | null = null;
  if (source) {
    const client = requireClient(deps);
    const row = installationRow(orm, project.teamId, source.installationId);
    account = row.accountLogin;
    const repo = await viaGithub('Repository', () => client.repo(row.installationId, source.repo));
    const ref = source.ref ?? repo.defaultBranch;
    if (source.type === 'file') {
      if (!isMarkdownPath(source.path)) throw errors.validation('Choose a Markdown (.md) file');
      await viaGithub('File', () =>
        client.contents(row.installationId, source.repo, source.path, ref),
      ).then((contents) => {
        if (contents.type !== 'file') throw errors.validation('That path is a folder, not a file');
      });
    } else {
      const contents = await viaGithub('Folder', () =>
        client.contents(row.installationId, source.repo, source.path, ref),
      );
      if (contents.type !== 'dir') throw errors.validation('That path is a file, not a folder');
      if (source.entry && !isInside(source.entry, source.path)) {
        throw errors.validation('The first page must be a Markdown file inside the folder');
      }
    }
  }
  const before = project.readmeSource ?? null;
  deps.db.write((tx) => {
    tx.update(s.project)
      .set({ readmeSource: source, updatedAt: new Date() })
      .where(eq(s.project.id, project.id))
      .run();
    recordActivity(tx, actor, {
      teamId: project.teamId,
      projectId: project.id,
      entityType: 'project',
      entityId: project.id,
      action: 'project.updated',
      changes: { readmeSource: { from: describeSource(before), to: describeSource(source) } },
      meta: { name: project.name, key: project.key, ...(account ? { account } : {}) },
    });
    emitAfterCommit(tx, {
      type: 'project.updated',
      teamId: project.teamId,
      projectId: project.id,
      entityType: 'project',
      entityId: project.id,
      actorId: actor.userId,
    });
  });
  return { readmeSource: source };
}

function describeSource(source: ReadmeSource | null): string {
  if (!source) return 'Written here';
  return `${source.repo}${source.path ? `/${source.path}` : ''}${source.type === 'folder' ? '/' : ''}`;
}

/** Is `path` the folder itself or inside it ("" is the repository root)? */
function isInside(path: string, folder: string): boolean {
  return folder === '' || path === folder || path.startsWith(`${folder}/`);
}

/** The folder a source's relative links and images resolve in. */
function sourceRoot(source: ReadmeSource): string {
  if (source.type === 'folder') return source.path;
  const slash = source.path.lastIndexOf('/');
  return slash < 0 ? '' : source.path.slice(0, slash);
}

function pickEntry(files: readonly string[], source: ReadmeSource): string | null {
  if (source.entry && files.includes(source.entry)) return source.entry;
  const prefix = source.path ? `${source.path}/` : '';
  for (const name of ['readme.md', 'index.md', 'readme.markdown']) {
    const found = files.find((file) => file.toLowerCase() === `${prefix}${name}`);
    if (found) return found;
  }
  return files[0] ?? null;
}

/**
 * One document of the project's GitHub README (any project member): the file, or for a folder
 * the Markdown files under it and the one asked for (`path`, else the entry, README.md or
 * index.md, else the first).
 */
export async function getGithubReadme(
  deps: AppDeps,
  actor: Actor,
  projectId: string,
  path: string | undefined,
): Promise<GithubReadme> {
  const { orm } = deps.db;
  const { project } = requireProject(orm, actor, projectId);
  const source = project.readmeSource;
  if (!source) throw errors.notFound('GitHub README');
  const client = requireClient(deps);
  const row = installationRow(orm, project.teamId, source.installationId);
  const id = row.installationId;
  const repo = await viaGithub('Repository', () => client.repo(id, source.repo));
  const ref = source.ref ?? repo.defaultBranch;
  const blob = (file: string) => `${repo.htmlUrl}/blob/${encodeURIComponent(ref)}/${file}`;
  const read = async (file: string) => {
    const contents = await viaGithub('File', () => client.contents(id, source.repo, file, ref));
    if (contents.type !== 'file') throw errors.notFound('File');
    if (contents.size > GITHUB_LIMITS.fileBytes || contents.content === null) {
      throw errors.payloadTooLarge('This file is too large to show');
    }
    return { path: file, content: contents.content, htmlUrl: blob(file) };
  };

  if (source.type === 'file') {
    if (path && path !== source.path) throw errors.notFound('File');
    return {
      repo: source.repo,
      ref,
      htmlUrl: blob(source.path),
      tree: null,
      doc: await read(source.path),
      truncated: false,
    };
  }

  const tree = await viaGithub('Folder', () => client.tree(id, source.repo, ref));
  const all = tree.entries
    .filter(
      (entry) =>
        entry.type === 'blob' && isMarkdownPath(entry.path) && isInside(entry.path, source.path),
    )
    .map((entry) => entry.path)
    .sort((a, b) => a.localeCompare(b));
  const files = all.slice(0, GITHUB_LIMITS.treeFiles);
  if (path && !files.includes(path)) throw errors.notFound('File');
  const chosen = path ?? pickEntry(files, source);
  return {
    repo: source.repo,
    ref,
    htmlUrl: `${repo.htmlUrl}/tree/${encodeURIComponent(ref)}${source.path ? `/${source.path}` : ''}`,
    tree: files.map((file) => ({ path: file, name: file.slice(file.lastIndexOf('/') + 1) })),
    doc: chosen ? await read(chosen) : null,
    truncated: tree.truncated || all.length > files.length,
  };
}

const IMAGE_TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  svg: 'image/svg+xml',
};

/**
 * An image of the project's GitHub README (any project member), for relative `![](img.png)`
 * links: only image files, only inside the source's folder.
 */
export async function getGithubReadmeImage(
  deps: AppDeps,
  actor: Actor,
  projectId: string,
  path: string,
): Promise<{ bytes: ArrayBuffer; contentType: string }> {
  const { orm } = deps.db;
  const { project } = requireProject(orm, actor, projectId);
  const source = project.readmeSource;
  if (!source) throw errors.notFound('Image');
  const extension = path.slice(path.lastIndexOf('.') + 1).toLowerCase();
  const contentType = IMAGE_TYPES[extension];
  if (!contentType || !isInside(path, sourceRoot(source))) throw errors.notFound('Image');
  const client = requireClient(deps);
  const row = installationRow(orm, project.teamId, source.installationId);
  const ref =
    source.ref ??
    (await viaGithub('Repository', () => client.repo(row.installationId, source.repo)))
      .defaultBranch;
  const bytes = await viaGithub('Image', () =>
    client.raw(row.installationId, source.repo, path, ref, GITHUB_LIMITS.imageBytes),
  );
  return { bytes, contentType };
}
