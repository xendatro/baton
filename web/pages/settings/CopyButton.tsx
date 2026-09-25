import { CheckIcon, CopyIcon } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@web/components/ui/button';
import { cn } from '@web/lib/utils';

/** Copies `value` to the clipboard, with a check mark for a moment afterwards. */
export function CopyButton({
  value,
  label = 'Copy',
  className,
  showLabel = false,
}: {
  value: string;
  /** Accessible name, and the visible text with `showLabel`. */
  label?: string;
  className?: string;
  showLabel?: boolean;
}) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);

  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
    } catch {
      toast.error('Couldn’t copy. Select the text and copy it yourself.');
    }
  }

  const Icon = copied ? CheckIcon : CopyIcon;
  return (
    <Button
      type="button"
      variant="outline"
      size={showLabel ? 'sm' : 'icon-sm'}
      className={cn('shrink-0', className)}
      aria-label={showLabel ? undefined : label}
      onClick={() => void copy()}
    >
      <Icon aria-hidden="true" className={copied ? 'text-emerald-600 dark:text-emerald-400' : ''} />
      {showLabel ? (copied ? 'Copied' : label) : null}
      <span className="sr-only" aria-live="polite">
        {copied ? 'Copied' : ''}
      </span>
    </Button>
  );
}

/** A monospace block with a copy button in its corner. */
export function CodeBlock({ code, label }: { code: string; label: string }) {
  return (
    <div className="relative min-w-0 rounded-md border bg-muted/50">
      <pre className="overflow-x-auto p-3 pr-12 font-mono text-xs leading-relaxed whitespace-pre">
        <code>{code}</code>
      </pre>
      <CopyButton value={code} label={label} className="absolute top-2 right-2 bg-background" />
    </div>
  );
}
