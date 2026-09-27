import { z } from 'zod';
import { idSchema, timestampSchema } from './common';
import { userSummarySchema } from './core';

/**
 * GitHub (repository READMEs): a team connects GitHub accounts or organizations by installing the
 * Baton GitHub App on the repositories it chooses; a project's overview can then show a Markdown
 * file of one of those repositories, or a folder of Markdown files as a tree.
 */

export const GITHUB_LIMITS = {
  /** Markdown files listed in a folder README. */
  treeFiles: 500,
  /** Largest Markdown file shown (bytes). */
  fileBytes: 1_000_000,
  /** Largest image served from a repository (bytes). */
  imageBytes: 5_000_000,
  path: 500,
} as const;

export const MARKDOWN_EXTENSIONS = ['.md', '.markdown', '.mdx'] as const;

export function isMarkdownPath(path: string): boolean {
  const lower = path.toLowerCase();
  return MARKDOWN_EXTENSIONS.some((extension) => lower.endsWith(extension));
}

/** `owner/name`. */
export const repoNameSchema = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/, 'A repository looks like owner/name');

/** A path inside a repository: no leading or trailing slash, no `..` ("" is the root). */
export const repoPathSchema = z
  .string()
  .trim()
  .max(GITHUB_LIMITS.path)
  .transform((value) => value.replace(/^\/+|\/+$/g, ''))
  .refine((value) => !value.split('/').some((part) => part === '..' || part === '.'), {
    message: 'Paths can’t contain . or ..',
  });

// ---------------------------------------------------------------------------------------------
// Installations and repositories
// ---------------------------------------------------------------------------------------------

export const githubInstallationSchema = z.object({
  id: z.string(),
  /** The GitHub account or organization it is installed on. */
  accountLogin: z.string(),
  accountType: z.string(),
  /** Where to change which repositories it can see, on GitHub. */
  settingsUrl: z.string(),
  createdBy: userSummarySchema.nullable(),
  createdAt: timestampSchema,
});
export type GithubInstallation = z.infer<typeof githubInstallationSchema>;

/** `GET /api/teams/:teamId/github`. */
export const githubStatusSchema = z.object({
  /** The server has a GitHub App configured. */
  enabled: z.boolean(),
  installations: z.array(githubInstallationSchema),
});
export type GithubStatus = z.infer<typeof githubStatusSchema>;

/** `POST /api/teams/:teamId/github/install`: where to send the browser. */
export const githubInstallUrlSchema = z.object({ url: z.string() });

export const githubRepoSchema = z.object({
  installationId: z.string(),
  fullName: z.string(),
  private: z.boolean(),
  defaultBranch: z.string(),
  htmlUrl: z.string(),
});
export type GithubRepo = z.infer<typeof githubRepoSchema>;

export const githubReposSchema = z.object({ repos: z.array(githubRepoSchema) });

export const githubEntrySchema = z.object({
  path: z.string(),
  name: z.string(),
  type: z.enum(['file', 'dir']),
});
export type GithubEntry = z.infer<typeof githubEntrySchema>;

/** `GET /api/github/installations/:id/contents?repo=&path=&ref=`: a folder's entries. */
export const githubContentsQuerySchema = z.object({
  repo: repoNameSchema,
  path: repoPathSchema.default(''),
  ref: z.string().trim().max(200).optional(),
});
export const githubContentsSchema = z.object({ entries: z.array(githubEntrySchema) });

// ---------------------------------------------------------------------------------------------
// A project's README source
// ---------------------------------------------------------------------------------------------

export const readmeSourceSchema = z.object({
  kind: z.literal('github'),
  /** A GitHub installation of the project's team (Baton's id). */
  installationId: idSchema,
  repo: repoNameSchema,
  /** Branch or tag (null: the repository's default branch). */
  ref: z.string().trim().min(1).max(200).nullable(),
  /** `file`: one Markdown file; `folder`: every Markdown file under `path`, as a tree. */
  type: z.enum(['file', 'folder']),
  path: repoPathSchema,
  /** `folder`: the file shown first, relative to the repository (null: README.md / index.md). */
  entry: repoPathSchema.nullable(),
});
export type ReadmeSource = z.infer<typeof readmeSourceSchema>;

/** `GET /api/projects/:projectId/readme/github?path=`: one document of the source. */
export const githubReadmeQuerySchema = z.object({ path: repoPathSchema.optional() });

export const githubReadmeSchema = z.object({
  repo: z.string(),
  ref: z.string(),
  /** The source on GitHub. */
  htmlUrl: z.string(),
  /** `folder`: every Markdown file under the folder, sorted by path. */
  tree: z.array(z.object({ path: z.string(), name: z.string() })).nullable(),
  doc: z.object({ path: z.string(), content: z.string(), htmlUrl: z.string() }).nullable(),
  /** The folder has more Markdown files than are listed. */
  truncated: z.boolean(),
});
export type GithubReadme = z.infer<typeof githubReadmeSchema>;

export const githubRepoFileQuerySchema = z.object({ path: repoPathSchema });
