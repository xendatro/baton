import type { QueryKey } from '@tanstack/react-query';
import { SmilePlusIcon } from 'lucide-react';
import { lazy, Suspense, useState } from 'react';
import { QUICK_REACTIONS, type ReactionTargetType } from '@shared/constants';
import type { ReactionSummary, Reactor } from '@shared/schemas/core';
import { Spinner } from '@web/components/common/Spinner';
import { Button } from '@web/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@web/components/ui/popover';
import { Tooltip, TooltipContent, TooltipTrigger } from '@web/components/ui/tooltip';
import { useMe } from '@web/lib/auth';
import { useTeamAccess } from '@web/lib/permissions';
import { cn } from '@web/lib/utils';
import { useReactionMutation } from './queries';
import { applyReaction, reactorsLabel } from './reactions';

const EmojiPickerPanel = lazy(() => import('./EmojiPickerPanel'));

export interface ReactionBarProps {
  targetType: ReactionTargetType;
  targetId: string;
  teamId: string;
  reactions: ReactionSummary[];
  /** The query holding `reactions`, refreshed after a change. */
  queryKey: QueryKey;
  className?: string;
}

/**
 * Emoji reactions under a reply, task or issue (BAT-14): a chip per emoji (count, highlighted
 * when the viewer reacted, names on hover; click to toggle), one-click quick reactions (shown on
 * hover or focus, always on touch screens) and a picker for any other emoji. Members without the
 * `REPLY` permission only see the chips.
 */
export function ReactionBar({
  targetType,
  targetId,
  teamId,
  reactions,
  queryKey,
  className,
}: ReactionBarProps) {
  const me = useMe().data?.user;
  const access = useTeamAccess(teamId);
  const canReact = access.has('REPLY');
  const mutation = useReactionMutation(targetType, targetId, queryKey);
  const [pickerOpen, setPickerOpen] = useState(false);
  // The viewer's change, shown until the refreshed `reactions` arrive (or the request fails).
  const [pending, setPending] = useState<{
    base: ReactionSummary[];
    value: ReactionSummary[];
  } | null>(null);
  const shown = pending?.base === reactions ? pending.value : reactions;

  const viewer: Reactor | null = me
    ? { id: me.id, username: me.username ?? '', name: me.name, image: me.image, via: null }
    : null;

  const toggle = (emoji: string, add: boolean) => {
    if (!viewer || !canReact) return;
    const current = shown.find((reaction) => reaction.emoji === emoji);
    if (add === Boolean(current?.reactedByMe)) return;
    setPending({ base: reactions, value: applyReaction(shown, emoji, viewer, add) });
    mutation.mutate({ emoji, remove: !add }, { onError: () => setPending(null) });
  };

  const present = new Set(shown.map((reaction) => reaction.emoji));
  const quick = QUICK_REACTIONS.filter((emoji) => !present.has(emoji));
  if (shown.length === 0 && !canReact) return null;

  return (
    <div
      role="group"
      aria-label="Reactions"
      className={cn('group/reactions flex min-h-7 flex-wrap items-center gap-1', className)}
    >
      {shown.map((reaction) => (
        <Tooltip key={reaction.emoji}>
          <TooltipTrigger asChild>
            <button
              type="button"
              aria-pressed={reaction.reactedByMe}
              aria-label={`React with ${reaction.emoji} (${reaction.count})`}
              aria-disabled={!canReact || undefined}
              onClick={() => toggle(reaction.emoji, !reaction.reactedByMe)}
              className={cn(
                'inline-flex h-6 items-center gap-1 rounded-full border px-2 text-xs tabular-nums transition-colors outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50',
                reaction.reactedByMe
                  ? 'border-primary/50 bg-primary/10 font-medium text-primary'
                  : 'bg-muted/40 text-muted-foreground hover:bg-muted',
                !canReact && 'cursor-default',
              )}
            >
              <span aria-hidden="true" className="text-sm leading-none">
                {reaction.emoji}
              </span>
              <span aria-hidden="true">{reaction.count}</span>
            </button>
          </TooltipTrigger>
          <TooltipContent className="max-w-64">
            {reactorsLabel(reaction, me?.id ?? null)}
          </TooltipContent>
        </Tooltip>
      ))}
      {canReact ? (
        <>
          <div className="flex items-center gap-0.5 transition-opacity [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-focus-within/reactions:opacity-100 [@media(hover:hover)]:group-hover/reactions:opacity-100">
            {quick.map((emoji) => (
              <button
                key={emoji}
                type="button"
                aria-label={`React with ${emoji}`}
                title={`React with ${emoji}`}
                onClick={() => toggle(emoji, true)}
                className="inline-flex size-6 items-center justify-center rounded-md text-sm leading-none grayscale-[0.4] transition hover:bg-muted hover:grayscale-0 focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
              >
                <span aria-hidden="true">{emoji}</span>
              </button>
            ))}
          </div>
          <Popover open={pickerOpen} onOpenChange={setPickerOpen}>
            <PopoverTrigger asChild>
              <Button
                variant="ghost"
                size="icon-xs"
                className="text-muted-foreground"
                aria-label="Add reaction"
                title="Add reaction"
              >
                <SmilePlusIcon aria-hidden="true" />
              </Button>
            </PopoverTrigger>
            <PopoverContent align="start" className="w-auto overflow-hidden p-0">
              <Suspense
                fallback={
                  <div className="flex h-[380px] w-[320px] items-center justify-center">
                    <Spinner />
                  </div>
                }
              >
                <EmojiPickerPanel
                  onPick={(emoji) => {
                    setPickerOpen(false);
                    toggle(emoji, true);
                  }}
                />
              </Suspense>
            </PopoverContent>
          </Popover>
        </>
      ) : null}
    </div>
  );
}
