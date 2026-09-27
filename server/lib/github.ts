import crypto from 'node:crypto';
import type { Env } from '../env';
import type { Logger } from '../logger';

/**
 * The GitHub App client (repository READMEs): signs app JWTs with the app's private key, trades
 * them for short-lived installation tokens (cached until shortly before they expire) and reads
 * repositories through the REST API. Calls go through the global `fetch`, so tests stub it.
 */

const API = 'https://api.github.com';
const CACHE_TTL_MS = 60_000;

export class GithubError extends Error {
  override name = 'GithubError';
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export interface GithubRepoInfo {
  fullName: string;
  private: boolean;
  defaultBranch: string;
  htmlUrl: string;
}

export interface GithubTreeEntry {
  path: string;
  type: 'blob' | 'tree';
  size: number;
}

export type GithubContents =
  | { type: 'dir'; entries: Array<{ path: string; name: string; type: 'file' | 'dir' }> }
  | { type: 'file'; path: string; size: number; content: string | null };

export interface GithubClient {
  /** `https://github.com/apps/<slug>/installations/new?state=…`. */
  installUrl(state: string): string;
  /** GitHub's OAuth authorize URL for the app (checks who installed what). */
  authorizeUrl(state: string, redirectUri: string): string;
  /** Trades an OAuth `code` for a user token, and lists the installations that user can access. */
  userInstallationIds(code: string, redirectUri: string): Promise<number[]>;
  installation(installationId: number): Promise<{ login: string; type: string }>;
  repos(installationId: number): Promise<GithubRepoInfo[]>;
  repo(installationId: number, repo: string): Promise<GithubRepoInfo>;
  contents(
    installationId: number,
    repo: string,
    path: string,
    ref: string,
  ): Promise<GithubContents>;
  tree(
    installationId: number,
    repo: string,
    ref: string,
  ): Promise<{ entries: GithubTreeEntry[]; truncated: boolean }>;
  /** A file's bytes (for images), refused above `maxBytes`. */
  raw(
    installationId: number,
    repo: string,
    path: string,
    ref: string,
    maxBytes: number,
  ): Promise<ArrayBuffer>;
}

function base64url(input: string | Buffer): string {
  return Buffer.from(input).toString('base64url');
}

function encodePath(path: string): string {
  return path
    .split('/')
    .filter(Boolean)
    .map((part) => encodeURIComponent(part))
    .join('/');
}

interface RawRepo {
  full_name: string;
  private: boolean;
  default_branch: string;
  html_url: string;
}

function repoInfo(raw: RawRepo): GithubRepoInfo {
  return {
    fullName: raw.full_name,
    private: raw.private,
    defaultBranch: raw.default_branch,
    htmlUrl: raw.html_url,
  };
}

/** Null when the server has no GitHub App configured. */
export function createGithubClient(env: Env, logger: Logger): GithubClient | null {
  const app = env.githubApp;
  const oauth = env.github;
  if (!app || !oauth) return null;
  const tokens = new Map<number, { token: string; expiresAt: number }>();
  // Reads are cached briefly, so every page view doesn't cost API calls (5,000/hour/installation).
  const cache = new Map<string, { expiresAt: number; value: Promise<unknown> }>();
  function cached<T>(key: string, load: () => Promise<T>): Promise<T> {
    const now = Date.now();
    const hit = cache.get(key);
    if (hit && hit.expiresAt > now) return hit.value as Promise<T>;
    if (cache.size > 500) {
      for (const [entry, value] of cache) if (value.expiresAt <= now) cache.delete(entry);
    }
    const value = load();
    cache.set(key, { expiresAt: now + CACHE_TTL_MS, value });
    value.catch(() => cache.delete(key));
    return value;
  }

  function appJwt(): string {
    const now = Math.floor(Date.now() / 1000);
    const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
    // Issued a minute early for clock drift; GitHub allows at most ten minutes.
    const payload = base64url(JSON.stringify({ iat: now - 60, exp: now + 540, iss: app?.appId }));
    const signature = crypto
      .createSign('RSA-SHA256')
      .update(`${header}.${payload}`)
      .sign(app?.privateKey ?? '');
    return `${header}.${payload}.${base64url(signature)}`;
  }

  async function call(
    path: string,
    token: string,
    init: RequestInit & { accept?: string } = {},
  ): Promise<Response> {
    const { accept, ...rest } = init;
    const res = await fetch(`${API}${path}`, {
      ...rest,
      headers: {
        accept: accept ?? 'application/vnd.github+json',
        authorization: `Bearer ${token}`,
        'x-github-api-version': '2022-11-28',
        'user-agent': 'Baton',
        ...(rest.headers as Record<string, string> | undefined),
      },
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      logger.debug({ status: res.status, path, body: text.slice(0, 300) }, 'GitHub API error');
      throw new GithubError(res.status, `GitHub answered ${res.status}`);
    }
    return res;
  }

  async function installationToken(installationId: number): Promise<string> {
    const cached = tokens.get(installationId);
    if (cached && cached.expiresAt - 5 * 60_000 > Date.now()) return cached.token;
    const res = await call(`/app/installations/${installationId}/access_tokens`, appJwt(), {
      method: 'POST',
    });
    const body = (await res.json()) as { token: string; expires_at: string };
    tokens.set(installationId, { token: body.token, expiresAt: Date.parse(body.expires_at) });
    return body.token;
  }

  async function asInstallation(installationId: number, path: string, accept?: string) {
    return call(path, await installationToken(installationId), accept ? { accept } : {});
  }

  async function loadContents(
    installationId: number,
    repo: string,
    path: string,
    ref: string,
  ): Promise<GithubContents> {
    const res = await asInstallation(
      installationId,
      `/repos/${repo}/contents/${encodePath(path)}?ref=${encodeURIComponent(ref)}`,
    );
    const body = (await res.json()) as
      | Array<{ path: string; name: string; type: string }>
      | { path: string; size: number; type: string; content?: string; encoding?: string };
    if (Array.isArray(body)) {
      return {
        type: 'dir',
        entries: body
          .filter((item) => item.type === 'file' || item.type === 'dir')
          .map((item) => ({
            path: item.path,
            name: item.name,
            type: item.type as 'file' | 'dir',
          })),
      };
    }
    if (body.type !== 'file') throw new GithubError(404, 'Not a file');
    return {
      type: 'file',
      path: body.path,
      size: body.size,
      content:
        body.encoding === 'base64' && body.content
          ? Buffer.from(body.content, 'base64').toString('utf8')
          : null,
    };
  }

  async function loadTree(
    installationId: number,
    repo: string,
    ref: string,
  ): Promise<{ entries: GithubTreeEntry[]; truncated: boolean }> {
    const body = (await (
      await asInstallation(
        installationId,
        `/repos/${repo}/git/trees/${encodeURIComponent(ref)}?recursive=1`,
      )
    ).json()) as { tree: Array<{ path: string; type: string; size?: number }>; truncated: boolean };
    return {
      entries: body.tree
        .filter((item) => item.type === 'blob' || item.type === 'tree')
        .map((item) => ({
          path: item.path,
          type: item.type as 'blob' | 'tree',
          size: item.size ?? 0,
        })),
      truncated: body.truncated,
    };
  }

  return {
    installUrl: (state) =>
      `https://github.com/apps/${encodeURIComponent(app.slug)}/installations/new?state=${encodeURIComponent(state)}`,

    authorizeUrl: (state, redirectUri) =>
      `https://github.com/login/oauth/authorize?${new URLSearchParams({
        client_id: oauth.clientId,
        redirect_uri: redirectUri,
        state,
      }).toString()}`,

    async userInstallationIds(code, redirectUri) {
      const res = await fetch('https://github.com/login/oauth/access_token', {
        method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/json' },
        body: JSON.stringify({
          client_id: oauth.clientId,
          client_secret: oauth.clientSecret,
          code,
          redirect_uri: redirectUri,
        }),
      });
      const body = (await res.json().catch(() => ({}))) as { access_token?: string };
      if (!res.ok || !body.access_token) throw new GithubError(401, 'GitHub sign-in failed');
      const ids: number[] = [];
      for (let page = 1; page <= 10; page += 1) {
        const list = (await (
          await call(`/user/installations?per_page=100&page=${page}`, body.access_token)
        ).json()) as { installations: Array<{ id: number }> };
        ids.push(...list.installations.map((item) => item.id));
        if (list.installations.length < 100) break;
      }
      return ids;
    },

    async installation(installationId) {
      const body = (await (
        await call(`/app/installations/${installationId}`, appJwt())
      ).json()) as {
        account: { login: string; type: string } | null;
      };
      return { login: body.account?.login ?? 'unknown', type: body.account?.type ?? 'User' };
    },

    async repos(installationId) {
      const repos: GithubRepoInfo[] = [];
      for (let page = 1; page <= 10; page += 1) {
        const body = (await (
          await asInstallation(
            installationId,
            `/installation/repositories?per_page=100&page=${page}`,
          )
        ).json()) as { repositories: RawRepo[] };
        repos.push(...body.repositories.map(repoInfo));
        if (body.repositories.length < 100) break;
      }
      return repos;
    },

    repo(installationId, repo) {
      return cached(`repo:${installationId}:${repo}`, async () =>
        repoInfo(
          (await (await asInstallation(installationId, `/repos/${repo}`)).json()) as RawRepo,
        ),
      );
    },

    contents(installationId, repo, path, ref) {
      return cached(`contents:${installationId}:${repo}:${ref}:${path}`, () =>
        loadContents(installationId, repo, path, ref),
      );
    },

    tree(installationId, repo, ref) {
      return cached(`tree:${installationId}:${repo}:${ref}`, () =>
        loadTree(installationId, repo, ref),
      );
    },

    async raw(installationId, repo, path, ref, maxBytes) {
      const res = await asInstallation(
        installationId,
        `/repos/${repo}/contents/${encodePath(path)}?ref=${encodeURIComponent(ref)}`,
        'application/vnd.github.raw+json',
      );
      const length = Number(res.headers.get('content-length') ?? 0);
      if (length > maxBytes) throw new GithubError(413, 'File too large');
      const bytes = await res.arrayBuffer();
      if (bytes.byteLength > maxBytes) throw new GithubError(413, 'File too large');
      return bytes;
    },
  };
}
