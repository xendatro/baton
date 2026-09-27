import { capture } from './harness/process';

/**
 * The repo check of "Projects & folders" (BAT-24): does the mapped folder's git remote match the
 * project's repository URL? Compares host and path, ignoring the protocol, `.git` and case.
 */

/** `https://github.com/Owner/Repo.git`, `git@github.com:owner/repo` → `github.com/owner/repo`. */
export function normalizeRepoUrl(url: string): string {
  let value = url.trim().toLowerCase();
  const ssh = /^[\w.-]+@([\w.-]+):(.+)$/.exec(value);
  if (ssh) value = `${ssh[1]}/${ssh[2]}`;
  value = value.replace(/^[a-z+]+:\/\//, '').replace(/^[^@/]+@/, '');
  return value.replace(/\.git$/, '').replace(/\/+$/, '');
}

export function sameRepo(a: string, b: string): boolean {
  return normalizeRepoUrl(a) === normalizeRepoUrl(b);
}

export type RepoCheck =
  | { state: 'match'; remote: string }
  | { state: 'mismatch'; remote: string; expected: string }
  | { state: 'not-a-repo' }
  | { state: 'no-repo-url' };

export async function checkRepo(
  folder: string,
  repoUrl: string | null | undefined,
): Promise<RepoCheck> {
  const remote = (await capture('git', ['-C', folder, 'remote', 'get-url', 'origin']))?.trim();
  if (!remote || /not a git repository|no such remote/i.test(remote))
    return { state: 'not-a-repo' };
  if (!repoUrl) return { state: 'no-repo-url' };
  return sameRepo(remote, repoUrl)
    ? { state: 'match', remote }
    : { state: 'mismatch', remote, expected: repoUrl };
}
