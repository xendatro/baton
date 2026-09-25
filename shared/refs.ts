/**
 * Human references to projects, tasks and issues:
 *   project  `KEY`      or `team-slug/KEY`
 *   task     `KEY-12`   or `team-slug/KEY-12`
 *   issue    `KEY#51`   or `team-slug/KEY#51`
 * Keys are 2–6 chars `[A-Z][A-Z0-9]{1,5}`; parsing is case-insensitive and normalises keys to
 * uppercase. Resolving a ref to an entity (and ambiguity across teams) is the server's job.
 */

export const PROJECT_KEY_PATTERN = /^[A-Z][A-Z0-9]{1,5}$/;
export const TEAM_SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const TEAM_SLUG_MAX = 40;
const MAX_NUMBER = 999_999_999;

export interface ProjectRef {
  kind: 'project';
  teamSlug: string | null;
  projectKey: string;
}

export interface NumberedRef {
  kind: 'task' | 'issue';
  teamSlug: string | null;
  projectKey: string;
  number: number;
}

export interface TaskRef extends NumberedRef {
  kind: 'task';
}

export interface IssueRef extends NumberedRef {
  kind: 'issue';
}

export type ParsedRef = ProjectRef | TaskRef | IssueRef;

const REF_PATTERN = /^(?:([a-z0-9]+(?:-[a-z0-9]+)*)\/)?([a-z][a-z0-9]{1,5})(?:([-#])(\d{1,9}))?$/i;

/** Parses any project, task or issue ref. Returns null when the input is not a ref. */
export function parseRef(input: string): ParsedRef | null {
  const match = REF_PATTERN.exec(input.trim());
  if (!match) return null;
  const [, rawSlug, rawKey, separator, rawNumber] = match;
  if (rawKey === undefined) return null;
  const teamSlug = rawSlug === undefined ? null : rawSlug.toLowerCase();
  if (teamSlug !== null && (teamSlug.length < 2 || teamSlug.length > TEAM_SLUG_MAX)) return null;
  const projectKey = rawKey.toUpperCase();
  if (separator === undefined || rawNumber === undefined) {
    return { kind: 'project', teamSlug, projectKey };
  }
  const number = Number(rawNumber);
  if (!Number.isSafeInteger(number) || number < 1 || number > MAX_NUMBER) return null;
  return { kind: separator === '#' ? 'issue' : 'task', teamSlug, projectKey, number };
}

export function parseProjectRef(input: string): ProjectRef | null {
  const ref = parseRef(input);
  return ref?.kind === 'project' ? ref : null;
}

export function parseTaskRef(input: string): TaskRef | null {
  const ref = parseRef(input);
  return ref?.kind === 'task' ? ref : null;
}

export function parseIssueRef(input: string): IssueRef | null {
  const ref = parseRef(input);
  return ref?.kind === 'issue' ? ref : null;
}

function withTeam(ref: string, teamSlug?: string | null): string {
  return teamSlug ? `${teamSlug}/${ref}` : ref;
}

export function formatProjectRef(projectKey: string, teamSlug?: string | null): string {
  return withTeam(projectKey, teamSlug);
}

export function formatTaskRef(
  projectKey: string,
  number: number,
  teamSlug?: string | null,
): string {
  return withTeam(`${projectKey}-${number}`, teamSlug);
}

export function formatIssueRef(
  projectKey: string,
  number: number,
  teamSlug?: string | null,
): string {
  return withTeam(`${projectKey}#${number}`, teamSlug);
}

export interface RefMatch {
  ref: TaskRef | IssueRef;
  /** The matched text, e.g. `KEY-12` or `acme/KEY#51`. */
  text: string;
  index: number;
}

// Uppercase keys only in prose, so ordinary words ("re-1") are not treated as refs.
const PROSE_REF_PATTERN =
  /(?<![\w/#-])(?:([a-z0-9]+(?:-[a-z0-9]+)*)\/)?([A-Z][A-Z0-9]{1,5})([-#])([1-9]\d{0,8})(?![\w-])/g;

/**
 * Finds task and issue refs in free text (markdown bodies, replies). Matches are candidates:
 * callers must still check that the project key exists (e.g. `UTF-8` looks like a task ref).
 */
export function findRefs(text: string): RefMatch[] {
  const matches: RefMatch[] = [];
  for (const match of text.matchAll(PROSE_REF_PATTERN)) {
    const ref = parseRef(match[0]);
    if (ref && ref.kind !== 'project') matches.push({ ref, text: match[0], index: match.index });
  }
  return matches;
}
