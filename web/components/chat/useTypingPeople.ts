import { useEffect, useState } from 'react';
import { CHAT_LIMITS, type ReplyParentType } from '@shared/constants';
import { useLiveEventListener } from '@web/lib/live';

/**
 * Who is typing in an item's chat: ids of the people whose `typing` live event arrived within the
 * last 5 s (the viewer excluded). A message from them ends their typing at once.
 */
export function useTypingPeople(
  type: ReplyParentType,
  id: string,
  viewerId: string | null,
): string[] {
  const [until, setUntil] = useState<ReadonlyMap<string, number>>(new Map());

  useLiveEventListener((event) => {
    if (!event.actorId || event.actorId === viewerId) return;
    if (event.type === 'typing' && event.entityType === type && event.entityId === id) {
      const actorId = event.actorId;
      setUntil((current) => new Map(current).set(actorId, Date.now() + CHAT_LIMITS.typingShowMs));
    } else if (
      event.type === 'reply.created' &&
      event.parentType === type &&
      event.parentId === id &&
      until.has(event.actorId)
    ) {
      const actorId = event.actorId;
      setUntil((current) => {
        const next = new Map(current);
        next.delete(actorId);
        return next;
      });
    }
  });

  // Forget people once their last ping is too old.
  useEffect(() => {
    if (until.size === 0) return;
    const next = Math.min(...until.values());
    const timer = setTimeout(
      () => {
        const now = Date.now();
        setUntil((current) => new Map([...current].filter(([, at]) => at > now)));
      },
      Math.max(0, next - Date.now()) + 10,
    );
    return () => clearTimeout(timer);
  }, [until]);

  return [...until.keys()];
}
