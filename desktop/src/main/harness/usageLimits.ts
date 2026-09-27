/**
 * Recognising "out of usage" and rate limits in a harness's output (BAT-24), so the app can move
 * on to the next harness of the chain and skip this one until its reset. Heuristic by design:
 * harnesses word it differently and change it; unknown resets fall back to an hour.
 */

const PATTERNS: readonly RegExp[] = [
  /usage limit/i,
  /rate[- ]limit(ed)?/i,
  /quota (exceeded|reached)/i,
  /exceeded your (current )?quota/i,
  /out of (usage|credits)/i,
  /\b429\b.*(too many requests|rate)/i,
  /too many requests/i,
  /resource[_ ]exhausted/i,
  /insufficient[_ ]quota/i,
  /limit (reached|exceeded).*(reset|try again)/i,
];

export const DEFAULT_BACKOFF_MS = 60 * 60 * 1000;

/** Is this output line about being out of usage? */
export function isOutOfUsage(text: string): boolean {
  return PATTERNS.some((pattern) => pattern.test(text));
}

/**
 * When the limit resets, if the text says so: a unix timestamp after a pipe (Claude Code's
 * `…limit reached|1767225600`), "resets at 17:00" / "try again at 5pm", or "in N minutes/hours".
 * Null when it doesn't.
 */
export function parseResetAt(text: string, now: number = Date.now()): number | null {
  const epoch = /\|(\d{10,13})\b/.exec(text);
  if (epoch?.[1]) {
    const value = Number(epoch[1]);
    return value < 1e12 ? value * 1000 : value;
  }
  const relative =
    /\bin (\d+(?:\.\d+)?)\s*(seconds?|secs?|minutes?|mins?|hours?|hrs?|h|m|s)\b/i.exec(text);
  if (relative?.[1] && relative[2]) {
    const amount = Number(relative[1]);
    const unit = relative[2].toLowerCase();
    const ms = unit.startsWith('h') ? 3_600_000 : unit.startsWith('m') ? 60_000 : 1_000;
    return now + amount * ms;
  }
  const clock =
    /\b(?:resets?|try again|available)\b[^0-9]{0,20}(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i.exec(text);
  if (clock?.[1]) {
    let hours = Number(clock[1]);
    const minutes = Number(clock[2] ?? 0);
    const meridiem = clock[3]?.toLowerCase();
    if (meridiem === 'pm' && hours < 12) hours += 12;
    if (meridiem === 'am' && hours === 12) hours = 0;
    if (hours > 23 || minutes > 59) return null;
    const date = new Date(now);
    date.setHours(hours, minutes, 0, 0);
    if (date.getTime() <= now) date.setDate(date.getDate() + 1);
    return date.getTime();
  }
  return null;
}
