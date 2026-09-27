import { differenceInCalendarDays, format, parseISO } from 'date-fns';
import {
  AtSignIcon,
  CircleCheckBigIcon,
  CircleDotIcon,
  MessageSquareIcon,
  ShieldAlertIcon,
  SquareCheckBigIcon,
  UserPlusIcon,
  UsersIcon,
  WorkflowIcon,
  type LucideIcon,
} from 'lucide-react';
import type { NotificationType } from '@shared/constants';
import type { MeProject, MeTeam, Notification } from '@shared/schemas/core';
import { isAgentUser } from '@web/lib/agentMembers';

/** Wording, icons and context of notifications, shared by the inbox and the live toasts. */

export interface NotificationKind {
  icon: LucideIcon;
  /** What the actor did: "Ada assigned you". */
  verb: string;
  /** Short name for filters and screen readers. */
  label: string;
  /** Icon tint (text color classes, light and dark). */
  tone: string;
}

export const NOTIFICATION_KINDS: Record<NotificationType, NotificationKind> = {
  mention: {
    icon: AtSignIcon,
    verb: 'mentioned you',
    label: 'Mention',
    tone: 'text-sky-600 dark:text-sky-400',
  },
  role_mention: {
    icon: UsersIcon,
    verb: 'mentioned a role you have',
    label: 'Role mention',
    tone: 'text-sky-600 dark:text-sky-400',
  },
  assigned: {
    icon: UserPlusIcon,
    verb: 'assigned you',
    label: 'Assigned',
    tone: 'text-violet-600 dark:text-violet-400',
  },
  reply: {
    icon: MessageSquareIcon,
    verb: 'replied',
    label: 'Reply',
    tone: 'text-muted-foreground',
  },
  issue_resolved: {
    icon: CircleCheckBigIcon,
    verb: 'resolved your issue',
    label: 'Issue resolved',
    tone: 'text-emerald-600 dark:text-emerald-400',
  },
  issue_reopened: {
    icon: CircleDotIcon,
    verb: 'reopened your issue',
    label: 'Issue reopened',
    tone: 'text-amber-600 dark:text-amber-400',
  },
  task_done: {
    icon: SquareCheckBigIcon,
    verb: 'moved a task to a new stage',
    label: 'Stage reached',
    tone: 'text-emerald-600 dark:text-emerald-400',
  },
  agent_action_request: {
    icon: ShieldAlertIcon,
    verb: 'needs your sign-off',
    label: 'Sign-off request',
    tone: 'text-amber-600 dark:text-amber-400',
  },
  stage_entered: {
    icon: WorkflowIcon,
    verb: 'moved a task into a stage you follow',
    label: 'Stage',
    tone: 'text-indigo-600 dark:text-indigo-400',
  },
};

/**
 * Who did it: the actor's name, or "Someone" when the row has none (a deleted account, or an
 * automatic change the server made).
 */
export function actorName(notification: Pick<Notification, 'actor'>): string {
  return notification.actor?.name ?? 'Someone';
}

/**
 * "Ada assigned you", "Ada AI replied" (an agent member), and for older rows "Ada via Claude on
 * laptop replied", "Claude via Ada’s MSI replied".
 */
export function notificationSentence(
  notification: Pick<Notification, 'actor' | 'viaKeyName' | 'viaAgentName' | 'type'>,
): string {
  const verb = NOTIFICATION_KINDS[notification.type].verb;
  if (isAgentUser(notification.actor)) return `${actorName(notification)} ${verb}`;
  if (notification.viaAgentName && notification.viaKeyName) {
    return `${notification.viaAgentName} via ${actorName(notification)}’s ${notification.viaKeyName} ${verb}`;
  }
  const via = notification.viaKeyName ? ` via ${notification.viaKeyName}` : '';
  return `${actorName(notification)}${via} ${verb}`;
}

export interface NotificationContext {
  team: MeTeam | null;
  project: MeProject | null;
}

/** The team (by id) and project (from the `/t/:team/p/:KEY/…` URL) a notification is about. */
export function notificationContext(
  notification: Pick<Notification, 'teamId' | 'url'>,
  teams: readonly MeTeam[],
): NotificationContext {
  const team = teams.find((candidate) => candidate.id === notification.teamId) ?? null;
  const match = /^\/t\/[^/]+\/p\/([^/?#]+)/.exec(notification.url);
  const key = match?.[1]?.toUpperCase();
  const project = key ? (team?.projects.find((candidate) => candidate.key === key) ?? null) : null;
  return { team, project };
}

/** "Today", "Yesterday", "Monday" within a week, then a date. */
export function dayLabel(iso: string, now: Date): string {
  const date = parseISO(iso);
  const days = differenceInCalendarDays(now, date);
  if (days <= 0) return 'Today';
  if (days === 1) return 'Yesterday';
  if (days < 7) return format(date, 'EEEE');
  return format(date, date.getFullYear() === now.getFullYear() ? 'MMMM d' : 'MMMM d, yyyy');
}
