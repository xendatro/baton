import crypto from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReadmeSource } from '@shared/schemas/github';
import type { Actor } from '../context';
import * as s from '../db/schema';
import { isAppError } from '../lib/errors';
import {
  addMember,
  createProject,
  createTeam,
  createTestContext,
  createUser,
  type CreatedProject,
  type CreatedTeam,
  type TestContext,
  type UserRow,
} from '../test/helpers';
import {
  completeGithubInstall,
  disconnectGithub,
  getGithubReadme,
  getGithubReadmeImage,
  getGithubStatus,
  githubSetupRedirect,
  listGithubContents,
  setReadmeSource,
  startGithubInstall,
} from './github';
import { getProject } from './projects';

/** GitHub (repository READMEs): connecting an installation safely, picking and showing sources. */

const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const PEM = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();

let ctx: TestContext;
let owner: UserRow;
let ben: UserRow;
let team: CreatedTeam;
let project: CreatedProject;
/** GitHub installations the signed-in GitHub user can access. */
let userInstallations: number[];

const web = (user: { id: string }): Actor => ({ userId: user.id, source: 'web', key: null });

function file(path: string, content: string) {
  return {
    type: 'file',
    path,
    size: content.length,
    encoding: 'base64',
    content: Buffer.from(content).toString('base64'),
  };
}

/** A fake GitHub: one installation (42) of `acme-gh`, with repo `acme-gh/docs`. */
function fakeGithub(url: string, init?: RequestInit): Response {
  const u = new URL(url);
  const route = `${init?.method ?? 'GET'} ${u.pathname}`;
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  switch (route) {
    case 'POST /login/oauth/access_token':
      return json({ access_token: 'user-token' });
    case 'GET /user/installations':
      return json({ installations: userInstallations.map((id) => ({ id })) });
    case 'GET /app/installations/42':
      return json({ account: { login: 'acme-gh', type: 'Organization' } });
    case 'POST /app/installations/42/access_tokens':
      return json({
        token: 'inst-token',
        expires_at: new Date(Date.now() + 3600_000).toISOString(),
      });
    case 'GET /repos/acme-gh/docs':
      return json({
        full_name: 'acme-gh/docs',
        private: true,
        default_branch: 'main',
        html_url: 'https://github.com/acme-gh/docs',
      });
    case 'GET /repos/acme-gh/docs/contents/docs':
      return json([
        { path: 'docs/README.md', name: 'README.md', type: 'file' },
        { path: 'docs/guide', name: 'guide', type: 'dir' },
      ]);
    case 'GET /repos/acme-gh/docs/contents/docs/README.md':
      return json(file('docs/README.md', '# Docs\n\nSee [the guide](guide/start.md).'));
    case 'GET /repos/acme-gh/docs/contents/docs/guide/start.md':
      return json(file('docs/guide/start.md', '# Start'));
    case 'GET /repos/acme-gh/docs/contents/docs/logo.png':
      return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
    case 'GET /repos/acme-gh/docs/git/trees/main':
      return json({
        truncated: false,
        tree: [
          { path: 'README.md', type: 'blob', size: 10 },
          { path: 'docs', type: 'tree' },
          { path: 'docs/README.md', type: 'blob', size: 10 },
          { path: 'docs/guide', type: 'tree' },
          { path: 'docs/guide/start.md', type: 'blob', size: 10 },
          { path: 'docs/logo.png', type: 'blob', size: 3 },
        ],
      });
    default:
      return json({ message: 'Not Found' }, 404);
  }
}

beforeEach(() => {
  ctx = createTestContext({
    env: {
      GITHUB_CLIENT_ID: 'client-id',
      GITHUB_CLIENT_SECRET: 'client-secret',
      GITHUB_APP_ID: '1234',
      GITHUB_APP_SLUG: 'baton-test',
      GITHUB_APP_PRIVATE_KEY: PEM,
    },
  });
  userInstallations = [42];
  vi.stubGlobal(
    'fetch',
    vi.fn((input: string | URL, init?: RequestInit) =>
      Promise.resolve(fakeGithub(String(input), init)),
    ),
  );
  owner = createUser(ctx.db, { username: 'owner' });
  ben = createUser(ctx.db, { username: 'ben' });
  team = createTeam(ctx.db, { ownerId: owner.id, slug: 'acme' });
  addMember(ctx.db, { teamId: team.team.id, userId: ben.id });
  project = createProject(ctx.db, { teamId: team.team.id, key: 'DOC', createdById: owner.id });
});

afterEach(() => {
  vi.unstubAllGlobals();
  ctx.close();
});

function stateOf(url: string): string {
  return new URL(url).searchParams.get('state') ?? '';
}

async function connect(): Promise<string> {
  const install = startGithubInstall(ctx.deps, web(owner), team.team.id);
  const authorize = githubSetupRedirect(ctx.deps, web(owner), {
    installation_id: '42',
    setup_action: 'install',
    state: stateOf(install.url),
  });
  return completeGithubInstall(ctx.deps, web(owner), { code: 'c', state: stateOf(authorize) });
}

async function failure(run: () => unknown): Promise<{ code: string; message: string }> {
  try {
    await run();
  } catch (error) {
    if (isAppError(error)) return { code: error.code, message: error.message };
    throw error;
  }
  throw new Error('expected a failure');
}

function installationId(): string {
  return ctx.db.orm.select().from(s.githubInstallation).get()?.id ?? '';
}

describe('connecting GitHub', () => {
  it('installs, checks the installation against the person on GitHub, and saves it', async () => {
    expect(getGithubStatus(ctx.deps, web(owner), team.team.id)).toEqual({
      enabled: true,
      installations: [],
    });
    const install = startGithubInstall(ctx.deps, web(owner), team.team.id);
    expect(install.url).toMatch(
      /^https:\/\/github\.com\/apps\/baton-test\/installations\/new\?state=/,
    );
    const authorize = githubSetupRedirect(ctx.deps, web(owner), {
      installation_id: '42',
      setup_action: 'install',
      state: stateOf(install.url),
    });
    expect(authorize).toMatch(
      /^https:\/\/github\.com\/login\/oauth\/authorize\?client_id=client-id/,
    );
    expect(
      await completeGithubInstall(ctx.deps, web(owner), { code: 'c', state: stateOf(authorize) }),
    ).toBe('/t/acme/settings/integrations?github=connected');
    const status = getGithubStatus(ctx.deps, web(ben), team.team.id);
    expect(status.installations).toMatchObject([
      { accountLogin: 'acme-gh', accountType: 'Organization', createdBy: { username: 'owner' } },
    ]);
  });

  it('refuses an installation the person can’t access on GitHub', async () => {
    userInstallations = [7];
    expect(await connect()).toBe('/t/acme/settings/integrations?github=denied');
    expect(ctx.db.orm.select().from(s.githubInstallation).all()).toHaveLength(0);
  });

  it('refuses forged, foreign and agent requests', async () => {
    expect((await failure(() => startGithubInstall(ctx.deps, web(ben), team.team.id))).code).toBe(
      'forbidden',
    );
    const agent: Actor = { userId: owner.id, source: 'mcp', key: { id: 'k', name: 'k' } };
    expect((await failure(() => startGithubInstall(ctx.deps, agent, team.team.id))).code).toBe(
      'forbidden',
    );
    const install = startGithubInstall(ctx.deps, web(owner), team.team.id);
    // Someone else's state, and a tampered one.
    const state = stateOf(install.url);
    expect(
      (
        await failure(() =>
          githubSetupRedirect(ctx.deps, web(ben), { installation_id: '42', state }),
        )
      ).code,
    ).toBe('validation_failed');
    expect(
      (
        await failure(() =>
          githubSetupRedirect(ctx.deps, web(owner), { installation_id: '42', state: `${state}x` }),
        )
      ).code,
    ).toBe('validation_failed');
  });

  it('is off without an app, and disconnecting resets projects that used it', async () => {
    await connect();
    const source: ReadmeSource = {
      kind: 'github',
      installationId: installationId(),
      repo: 'acme-gh/docs',
      ref: null,
      type: 'folder',
      path: 'docs',
      entry: null,
    };
    await setReadmeSource(ctx.deps, web(owner), project.project.id, source);
    disconnectGithub(ctx.deps, web(owner), team.team.id, installationId());
    expect(getProject(ctx.deps, web(owner), project.project.id).readmeSource).toBeNull();

    const plain = createTestContext();
    expect(plain.deps.github).toBeNull();
    plain.close();
  });
});

describe('a project’s GitHub README', () => {
  let source: ReadmeSource;
  beforeEach(async () => {
    await connect();
    source = {
      kind: 'github',
      installationId: installationId(),
      repo: 'acme-gh/docs',
      ref: null,
      type: 'folder',
      path: 'docs',
      entry: null,
    };
  });

  it('browses folders for the picker', async () => {
    const { entries } = await listGithubContents(
      ctx.deps,
      web(owner),
      team.team.id,
      installationId(),
      { repo: 'acme-gh/docs', path: 'docs' },
    );
    expect(entries.map((entry) => `${entry.type}:${entry.name}`)).toEqual([
      'dir:guide',
      'file:README.md',
    ]);
  });

  it('shows a folder as a tree of Markdown files, starting at its README', async () => {
    await setReadmeSource(ctx.deps, web(owner), project.project.id, source);
    const readme = await getGithubReadme(ctx.deps, web(ben), project.project.id, undefined);
    expect(readme.tree?.map((item) => item.path)).toEqual([
      'docs/guide/start.md',
      'docs/README.md',
    ]);
    expect(readme.doc).toMatchObject({
      path: 'docs/README.md',
      htmlUrl: 'https://github.com/acme-gh/docs/blob/main/docs/README.md',
    });
    expect(readme.doc?.content).toContain('# Docs');
    const start = await getGithubReadme(
      ctx.deps,
      web(ben),
      project.project.id,
      'docs/guide/start.md',
    );
    expect(start.doc?.content).toBe('# Start');
    // Nothing outside the folder.
    expect(
      (await failure(() => getGithubReadme(ctx.deps, web(ben), project.project.id, 'README.md')))
        .code,
    ).toBe('not_found');
  });

  it('shows one file, and serves only images inside the source', async () => {
    await setReadmeSource(ctx.deps, web(owner), project.project.id, {
      ...source,
      type: 'file',
      path: 'docs/README.md',
    });
    const readme = await getGithubReadme(ctx.deps, web(ben), project.project.id, undefined);
    expect(readme.tree).toBeNull();
    expect(readme.doc?.path).toBe('docs/README.md');
    const image = await getGithubReadmeImage(
      ctx.deps,
      web(ben),
      project.project.id,
      'docs/logo.png',
    );
    expect(image.contentType).toBe('image/png');
    expect(new Uint8Array(image.bytes)).toEqual(new Uint8Array([1, 2, 3]));
    expect(
      (
        await failure(() =>
          getGithubReadmeImage(ctx.deps, web(ben), project.project.id, 'secret.png'),
        )
      ).code,
    ).toBe('not_found');
    expect(
      (
        await failure(() =>
          getGithubReadmeImage(ctx.deps, web(ben), project.project.id, 'docs/x.env'),
        )
      ).code,
    ).toBe('not_found');
  });

  it('checks the source on GitHub and needs MANAGE_PROJECTS', async () => {
    expect(
      (await failure(() => setReadmeSource(ctx.deps, web(ben), project.project.id, source))).code,
    ).toBe('forbidden');
    expect(
      (
        await failure(() =>
          setReadmeSource(ctx.deps, web(owner), project.project.id, { ...source, path: 'nope' }),
        )
      ).code,
    ).toBe('not_found');
    expect(
      (
        await failure(() =>
          setReadmeSource(ctx.deps, web(owner), project.project.id, {
            ...source,
            type: 'file',
            path: 'docs/logo.png',
          }),
        )
      ).message,
    ).toBe('Choose a Markdown (.md) file');
    await setReadmeSource(ctx.deps, web(owner), project.project.id, source);
    expect(getProject(ctx.deps, web(ben), project.project.id).readmeSource).toEqual(source);
    await setReadmeSource(ctx.deps, web(owner), project.project.id, null);
    const row = ctx.db.orm
      .select()
      .from(s.project)
      .where(eq(s.project.id, project.project.id))
      .get();
    expect(row?.readmeSource).toBeNull();
  });
});
