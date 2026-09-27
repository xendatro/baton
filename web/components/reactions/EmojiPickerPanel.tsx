import EmojiPicker, { EmojiStyle, Theme } from 'emoji-picker-react';
import { useTheme } from '@web/lib/theme';

/**
 * The full emoji picker, loaded on demand (`React.lazy`) so its emoji data stays out of the main
 * bundle. Native emoji only: the CSP allows no image CDN.
 */
export default function EmojiPickerPanel({ onPick }: { onPick: (emoji: string) => void }) {
  const { resolvedTheme } = useTheme();
  return (
    <EmojiPicker
      emojiStyle={EmojiStyle.NATIVE}
      theme={resolvedTheme === 'dark' ? Theme.DARK : Theme.LIGHT}
      onEmojiClick={(data) => onPick(data.emoji)}
      previewConfig={{ showPreview: false }}
      searchPlaceholder="Search emoji"
      autoFocusSearch
      lazyLoadEmojis
      width={320}
      height={380}
    />
  );
}
