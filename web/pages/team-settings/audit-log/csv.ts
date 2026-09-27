import type { ActivityEntry } from '@shared/schemas/core';
import { activitySentence } from '@web/lib/activityText';

/**
 * CSV export of audit-log rows (RFC 4180: comma separated, CRLF line ends, quoted fields). Cells
 * that a spreadsheet would run as a formula (starting with =, +, -, @, tab or CR) are prefixed
 * with an apostrophe.
 */

const COLUMNS = [
  'time',
  'actor_username',
  'actor_name',
  'source',
  'via_key',
  'via_agent',
  'action',
  'summary',
  'entity_type',
  'entity_id',
  'url',
  'changes',
] as const;

function cell(value: string): string {
  const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

/** Absolute app URL of an entry's entity, or ''. */
function absolute(url: string | null, origin: string): string {
  return url ? new URL(url, origin).toString() : '';
}

export function auditLogCsv(entries: readonly ActivityEntry[], origin: string): string {
  const rows = entries.map((entry) => [
    entry.createdAt,
    entry.actor.user?.username ?? (entry.actor.source === 'system' ? 'system' : ''),
    entry.actor.user?.name ?? (entry.actor.source === 'system' ? 'Baton' : 'Deleted user'),
    entry.actor.source,
    entry.actor.via?.keyName ?? '',
    entry.actor.via?.agentName ?? '',
    entry.action,
    activitySentence(entry, { subject: 'entity' }),
    entry.entityType,
    entry.entityId,
    absolute(entry.url, origin),
    Object.keys(entry.changes).length ? JSON.stringify(entry.changes) : '',
  ]);
  return [COLUMNS as readonly string[], ...rows]
    .map((row) => row.map(cell).join(','))
    .join('\r\n')
    .concat('\r\n');
}

/** `audit-log-<team>-<yyyy-mm-dd>.csv`. */
export function csvFileName(teamSlug: string, now: Date = new Date()): string {
  const day = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0'),
  ].join('-');
  return `audit-log-${teamSlug}-${day}.csv`;
}

/** Saves `csv` through a temporary object URL (with a BOM, so spreadsheets read UTF-8). */
export function downloadCsv(csv: string, fileName: string): void {
  const blob = new Blob(['﻿', csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  link.rel = 'noopener';
  document.body.append(link);
  link.click();
  link.remove();
  // Revoke after the click has been handled.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
