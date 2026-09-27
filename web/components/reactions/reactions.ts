import type { ReactionSummary, Reactor } from '@shared/schemas/core';

/** "Ethan Ho", or "Claude via Ethan Ho’s MSI" for a reaction an agent added through a key. */
export function reactorName(reactor: Reactor): string {
  const { via } = reactor;
  if (via?.agentName) return `${via.agentName} via ${reactor.name}’s ${via.keyName}`;
  if (via) return `${reactor.name} via ${via.keyName}`;
  return reactor.name;
}

/** The tooltip of a reaction chip: who reacted, oldest first. */
export function reactorsLabel(reaction: ReactionSummary, viewerId: string | null): string {
  const names = reaction.users.map((user) =>
    user.id === viewerId && !user.via ? 'You' : reactorName(user),
  );
  const shown = names.slice(0, 10);
  const more = names.length - shown.length;
  const list = more > 0 ? `${shown.join(', ')} and ${more} more` : shown.join(', ');
  return `${list} reacted with ${reaction.emoji}`;
}

/**
 * `reactions` after the viewer adds (`add`) or removes their `emoji`, as the server will return
 * them: shown at once while the request runs.
 */
export function applyReaction(
  reactions: readonly ReactionSummary[],
  emoji: string,
  viewer: Reactor,
  add: boolean,
): ReactionSummary[] {
  const existing = reactions.find((reaction) => reaction.emoji === emoji);
  if (add) {
    if (!existing) {
      return [...reactions, { emoji, count: 1, reactedByMe: true, users: [viewer] }];
    }
    if (existing.reactedByMe) return [...reactions];
    return reactions.map((reaction) =>
      reaction === existing
        ? {
            ...reaction,
            count: reaction.count + 1,
            reactedByMe: true,
            users: [...reaction.users, viewer],
          }
        : reaction,
    );
  }
  if (!existing?.reactedByMe) return [...reactions];
  return reactions.flatMap((reaction) => {
    if (reaction !== existing) return [reaction];
    const users = reaction.users.filter((user) => user.id !== viewer.id);
    return users.length > 0
      ? [{ ...reaction, count: users.length, reactedByMe: false, users }]
      : [];
  });
}
