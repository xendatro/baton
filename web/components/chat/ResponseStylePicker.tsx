import { MessageCircleIcon, MessagesSquareIcon } from 'lucide-react';
import type { ConversationMode } from '@shared/constants';
import { ToggleGroup, ToggleGroupItem } from '@web/components/ui/toggle-group';
import { cn } from '@web/lib/utils';

/**
 * "Response style: Chat · Forum" of a new issue or task: a flat group chat (the default) or the
 * threaded forum. It can be switched later from the item's menu.
 */
export function ResponseStylePicker({
  value,
  onChange,
  className,
}: {
  value: ConversationMode;
  onChange: (mode: ConversationMode) => void;
  className?: string;
}) {
  return (
    <div className={cn('flex items-center gap-2', className)}>
      <span id="response-style-label" className="text-sm text-muted-foreground">
        Response style:
      </span>
      <ToggleGroup
        type="single"
        variant="outline"
        size="sm"
        value={value}
        onValueChange={(next) => {
          if (next === 'chat' || next === 'forum') onChange(next);
        }}
        aria-labelledby="response-style-label"
      >
        <ToggleGroupItem value="chat" aria-label="Chat" title="A group chat: quick messages">
          <MessageCircleIcon aria-hidden="true" />
          Chat
        </ToggleGroupItem>
        <ToggleGroupItem value="forum" aria-label="Forum" title="Threaded comments">
          <MessagesSquareIcon aria-hidden="true" />
          Forum
        </ToggleGroupItem>
      </ToggleGroup>
    </div>
  );
}
